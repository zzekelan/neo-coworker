import {
  areMemoryEntriesEquivalent,
  getMemoryCharLimit,
  MemoryAmbiguousMatchError,
  MemoryOverflowError,
  MemorySecurityError,
  MemoryValidationError,
  normalizeMemoryContent,
  normalizeMemoryMetadata,
  previewMemoryEntry,
  renderMemorySnapshot,
  measureMemoryEntries,
  type MemoryEntry,
  type MemoryMetadata,
  type MemorySearchResult,
  type MemoryStore,
  type MemoryTarget,
} from "../domain/memory"
import { scanForInjection } from "../domain/security"
import type { MemoryRepository } from "./ports/repository"

export type MemoryObserverEvent = {
  sessionId: string
  runId: string
  type:
    | "memory.loaded"
    | "memory.add"
    | "memory.replace"
    | "memory.remove"
    | "memory.overflow_rejected"
    | "memory.security_blocked"
  payload: Record<string, unknown>
}

export type MemoryObserverPort = {
  recordMemoryEvent?(event: MemoryObserverEvent): void | Promise<void>
}

export type CreateMemoryServiceInput = {
  repository: MemoryRepository
  memoryObserver?: MemoryObserverPort
  observerContext?: {
    sessionId: string
    runId: string
  }
}

export function createMemoryService(input: CreateMemoryServiceInput): MemoryStore {
  const snapshotPromise = Promise.all([
    input.repository.load("agent"),
    input.repository.load("user"),
  ]).then(([agentEntries, userEntries]) =>
    renderMemorySnapshot({
      agentEntries,
      userEntries,
    }),
  )

  return {
    async add(target, content, metadata) {
      const normalizedContent = requireContent(content, "Content cannot be empty.")
      const normalizedMetadata = normalizeMemoryMetadata(metadata)
      await assertSafeContent(input, target, normalizedContent)

      const entries = await input.repository.load(target)
      const nextEntries = [
        ...entries,
        createEntry(target, normalizedContent, normalizedMetadata),
      ]

      await assertWithinLimit(input, target, entries, nextEntries)
      await input.repository.save(target, nextEntries)
      await observeMemoryEvent(input, {
        type: "memory.add",
        payload: {
          target,
          contentLength: normalizedContent.length,
          hasMetadata: normalizedMetadata !== undefined,
        },
      })

      return {
        target,
        entries: cloneEntries(nextEntries),
      }
    },
    async replace(target, search, newContent) {
      const normalizedSearch = requireContent(search, "Search text cannot be empty.")
      const normalizedContent = requireContent(newContent, "Replacement content cannot be empty.")
      await assertSafeContent(input, target, normalizedContent)

      const entries = await input.repository.load(target)
      const matchIndex = findSingleMatchIndex(target, entries, normalizedSearch)

      if (matchIndex === null) {
        const result = buildSearchResult(target, entries, false)
        await observeMemoryEvent(input, {
          type: "memory.replace",
          payload: {
            target,
            searchTerm: normalizedSearch,
            found: false,
          },
        })
        return result
      }

      const nextEntries = entries.map((entry, index) =>
        index === matchIndex
          ? {
              ...entry,
              content: normalizedContent,
            }
          : entry,
      )

      await assertWithinLimit(input, target, entries, nextEntries)
      await input.repository.save(target, nextEntries)
      await observeMemoryEvent(input, {
        type: "memory.replace",
        payload: {
          target,
          searchTerm: normalizedSearch,
          found: true,
        },
      })

      return buildSearchResult(target, nextEntries, true)
    },
    async remove(target, search) {
      const normalizedSearch = requireContent(search, "Search text cannot be empty.")
      const entries = await input.repository.load(target)
      const matchIndex = findSingleMatchIndex(target, entries, normalizedSearch)

      if (matchIndex === null) {
        const result = buildSearchResult(target, entries, false)
        await observeMemoryEvent(input, {
          type: "memory.remove",
          payload: {
            target,
            searchTerm: normalizedSearch,
            found: false,
          },
        })
        return result
      }

      const nextEntries = entries.filter((_entry, index) => index !== matchIndex)

      await input.repository.save(target, nextEntries)
      await observeMemoryEvent(input, {
        type: "memory.remove",
        payload: {
          target,
          searchTerm: normalizedSearch,
          found: true,
        },
      })

      return buildSearchResult(target, nextEntries, true)
    },
    async load(target) {
      const entries = await input.repository.load(target)
      await observeMemoryEvent(input, {
        type: "memory.loaded",
        payload: {
          target,
          entryCount: entries.length,
        },
      })
      return cloneEntries(entries)
    },
    async getSnapshot() {
      return await snapshotPromise
    },
  }
}

function createEntry(target: MemoryTarget, content: string, metadata?: MemoryMetadata): MemoryEntry {
  return metadata ? { target, content, metadata } : { target, content }
}

function cloneEntries(entries: MemoryEntry[]) {
  return entries.map((entry) =>
    entry.metadata
      ? {
          target: entry.target,
          content: entry.content,
          metadata: { ...entry.metadata },
        }
      : {
          target: entry.target,
          content: entry.content,
        },
  )
}

function buildSearchResult(
  target: MemoryTarget,
  entries: MemoryEntry[],
  found: boolean,
): MemorySearchResult {
  return {
    target,
    found,
    entries: cloneEntries(entries),
  }
}

function requireContent(content: string, message: string) {
  const normalized = normalizeMemoryContent(content)

  if (normalized.length === 0) {
    throw new MemoryValidationError(message)
  }

  return normalized
}

function findSingleMatchIndex(target: MemoryTarget, entries: MemoryEntry[], search: string) {
  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.content.includes(search))

  if (matches.length === 0) {
    return null
  }

  if (matches.length === 1) {
    return matches[0]!.index
  }

  const firstMatch = matches[0]!

  if (matches.every(({ entry }) => areMemoryEntriesEquivalent(entry, firstMatch.entry))) {
    return firstMatch.index
  }

  throw new MemoryAmbiguousMatchError(
    target,
    search,
    matches.map(({ entry }) => previewMemoryEntry(entry)),
  )
}

async function assertWithinLimit(
  input: CreateMemoryServiceInput,
  target: MemoryTarget,
  currentEntries: MemoryEntry[],
  nextEntries: MemoryEntry[],
) {
  const limit = getMemoryCharLimit(target)
  const currentSize = measureMemoryEntries(currentEntries)
  const attemptedSize = measureMemoryEntries(nextEntries)

  if (attemptedSize <= limit) {
    return
  }

  await observeMemoryEvent(input, {
    type: "memory.overflow_rejected",
    payload: {
      target,
      currentSize,
      attemptedSize,
      limit,
    },
  })

  throw new MemoryOverflowError({
    target,
    currentSize,
    attemptedSize,
    limit,
  })
}

async function observeMemoryEvent(
  input: CreateMemoryServiceInput,
  event: Omit<MemoryObserverEvent, "sessionId" | "runId">,
) {
  if (!input.observerContext) {
    return
  }

  try {
    await input.memoryObserver?.recordMemoryEvent?.({
      sessionId: input.observerContext.sessionId,
      runId: input.observerContext.runId,
      ...event,
    })
  } catch {
  }
}

async function assertSafeContent(
  input: CreateMemoryServiceInput,
  target: MemoryTarget,
  content: string,
) {
  const result = scanForInjection(content)
  if (result.safe) {
    return
  }

  await observeMemoryEvent(input, {
    type: "memory.security_blocked",
    payload: {
      target,
      threats: result.threats,
    },
  })

  throw new MemorySecurityError(target, result.threats)
}

export type { MemoryRepository } from "./ports/repository"
export type {
  MemoryEntry,
  MemoryMetadata,
  MemoryMutationResult,
  MemorySearchResult,
  MemoryStore,
  MemoryTarget,
} from "../domain/memory"
export {
  getMemoryCharLimit,
  getMemoryFileName,
  MEMORY_CHAR_LIMITS,
  MEMORY_ENTRY_DELIMITER,
  MEMORY_FILES,
  measureMemoryEntries,
  MemoryAmbiguousMatchError,
  MemoryError,
  MemoryOverflowError,
  MemorySecurityError,
  MemoryValidationError,
  renderMemoryBlock,
  renderMemorySnapshot,
} from "../domain/memory"
export { scanForInjection } from "../domain/security"
