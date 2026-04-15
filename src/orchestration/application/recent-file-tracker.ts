import { countTokens } from "gpt-tokenizer/model/gpt-4o"
import type { OrchestrationTranscriptMessage } from "./ports/session"

const MAX_TRACKED_FILES = 10
const MAX_RECOVERY_FILES = 5
const MAX_TOKENS_PER_FILE = 5_000
const MAX_FILE_RECOVERY_TOKENS = 50_000
const TRUNCATION_MARKER = "\n...[truncated]"

type RecentFileEntry = {
  path: string
  content: string
  tokenCount: number
}

export type RecentFileRecoveryReminder = {
  text: string
  filePaths: string[]
}

export function createRecentFileTracker() {
  const sessionEntries = new Map<string, RecentFileEntry[]>()

  return {
    recordRead(input: {
      sessionId: string
      path: string
      content: string
    }) {
      const path = input.path.trim()
      const content = input.content.trim()
      if (!path || !content) {
        return
      }

      const truncatedContent = truncateTextToTokenLimit(content, MAX_TOKENS_PER_FILE)
      const nextEntry: RecentFileEntry = {
        path,
        content: truncatedContent,
        tokenCount: countTokens(truncatedContent),
      }
      const existing = sessionEntries.get(input.sessionId) ?? []
      const deduped = existing.filter((entry) => entry.path !== path)
      deduped.push(nextEntry)

      while (deduped.length > MAX_TRACKED_FILES) {
        deduped.shift()
      }

      sessionEntries.set(input.sessionId, deduped)
    },
    buildRecoveryReminder(sessionId: string): RecentFileRecoveryReminder | null {
      return buildRecoveryReminderFromEntries(sessionEntries.get(sessionId) ?? [])
    },
  }
}

export function buildRecentFileRecoveryReminderFromTranscript(
  transcript: OrchestrationTranscriptMessage[],
): RecentFileRecoveryReminder | null {
  return buildRecoveryReminderFromEntries(collectRecentReadEntriesFromTranscript(transcript))
}

function buildRecoveryReminderFromEntries(
  entriesInput: readonly RecentFileEntry[],
): RecentFileRecoveryReminder | null {
  const entries = entriesInput.slice().reverse()
  if (entries.length === 0) {
    return null
  }

  const selected: RecentFileEntry[] = []
  let remainingTokens = MAX_FILE_RECOVERY_TOKENS

  for (const entry of entries) {
    if (selected.length >= MAX_RECOVERY_FILES) {
      break
    }

    if (entry.tokenCount > remainingTokens) {
      continue
    }

    selected.push(entry)
    remainingTokens -= entry.tokenCount
  }

  if (selected.length === 0) {
    return null
  }

  return {
    text: [
      "<system-reminder>",
      "Recent file context:",
      "",
      ...selected.map((entry) => `### ${entry.path}\n${entry.content}`),
      "</system-reminder>",
    ].join("\n"),
    filePaths: selected.map((entry) => entry.path),
  }
}

function collectRecentReadEntriesFromTranscript(transcript: OrchestrationTranscriptMessage[]) {
  const readCallPaths = new Map<string, string>()
  const recentEntries = new Map<string, RecentFileEntry>()

  for (const message of transcript) {
    for (const part of message.parts) {
      if (part.kind === "tool_call") {
        const data = readObject(part.data)
        if (readString(data, "toolName") !== "read") {
          continue
        }

        const callId = readString(data, "callId")
        const inputText = readString(data, "inputText") ?? part.text ?? ""
        const path = parseReadToolPath(inputText)

        if (!callId || !path) {
          continue
        }

        readCallPaths.set(createToolCallKey(message.runId, callId), path)
        continue
      }

      if (part.kind !== "tool_result") {
        continue
      }

      const data = readObject(part.data)
      if (readString(data, "toolName") !== "read") {
        continue
      }

      const callId = readString(data, "callId")
      if (!callId) {
        continue
      }

      const path = readCallPaths.get(createToolCallKey(message.runId, callId))
      const content = (part.text ?? readString(data, "output") ?? "").trim()
      if (!path || !content) {
        continue
      }

      const entry = createRecentFileEntry(path, content)
      recentEntries.delete(path)
      recentEntries.set(path, entry)
    }
  }

  return [...recentEntries.values()]
}

function createRecentFileEntry(path: string, content: string): RecentFileEntry {
  const truncatedContent = truncateTextToTokenLimit(content, MAX_TOKENS_PER_FILE)

  return {
    path,
    content: truncatedContent,
    tokenCount: countTokens(truncatedContent),
  }
}

function createToolCallKey(runId: string, callId: string) {
  return `${runId}:${callId}`
}

function parseReadToolPath(inputText: string) {
  try {
    const parsed = JSON.parse(inputText)
    return readString(readObject(parsed), "path")?.trim() || null
  } catch {
    return null
  }
}

function readObject(value: unknown) {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readString(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "string" ? (value[key] as string) : null
}

function truncateTextToTokenLimit(text: string, tokenLimit: number) {
  if (countTokens(text) <= tokenLimit) {
    return text
  }

  let low = 0
  let high = text.length
  let best = ""

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = `${text.slice(0, middle).trimEnd()}${TRUNCATION_MARKER}`
    if (countTokens(candidate) <= tokenLimit) {
      best = candidate
      low = middle + 1
      continue
    }

    high = middle - 1
  }

  return best || text.slice(0, Math.max(0, high)).trimEnd()
}
