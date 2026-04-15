import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  getMemoryFileName,
  MEMORY_ENTRY_DELIMITER,
  normalizeMemoryContent,
  normalizeMemoryMetadata,
  type MemoryEntry,
  type MemoryTarget,
} from "../domain/memory"
import type { MemoryRepository } from "../application/ports/repository"

const FRONTMATTER_BOUNDARY = "---"

export function getMemoryFilePath(basePath: string, target: MemoryTarget) {
  return join(basePath, getMemoryFileName(target))
}

export function createMarkdownMemoryRepository(basePath: string): MemoryRepository {
  return {
    async load(target) {
      const filePath = getMemoryFilePath(basePath, target)

      let content: string
      try {
        content = await readFile(filePath, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return []
        }

        throw error
      }

      return parseMarkdownEntries(content, target)
    },
    async save(target, entries) {
      const filePath = getMemoryFilePath(basePath, target)
      await mkdir(basePath, { recursive: true })
      await withFileLock(`${filePath}.lock`, async () => {
        const temporaryPath = join(
          dirname(filePath),
          `.${basename(filePath)}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`,
        )

        try {
          await writeFile(temporaryPath, serializeMarkdownEntries(entries), "utf8")
          await rename(temporaryPath, filePath)
        } catch (error) {
          await unlink(temporaryPath).catch(() => undefined)
          throw error
        }
      })
    },
  }
}

function parseMarkdownEntries(content: string, target: MemoryTarget): MemoryEntry[] {
  const normalizedContent = content.replace(/\r\n/g, "\n").trim()

  if (normalizedContent.length === 0) {
    return []
  }

  return normalizedContent
    .split(MEMORY_ENTRY_DELIMITER)
    .map((chunk) => parseMarkdownEntry(chunk, target))
    .filter((entry): entry is MemoryEntry => entry !== null)
}

function parseMarkdownEntry(chunk: string, target: MemoryTarget): MemoryEntry | null {
  const normalizedChunk = chunk.trim()
  if (normalizedChunk.length === 0) {
    return null
  }

  const frontmatterPrefix = `${FRONTMATTER_BOUNDARY}\n`
  const frontmatterSuffix = `\n${FRONTMATTER_BOUNDARY}\n`

  if (!normalizedChunk.startsWith(frontmatterPrefix)) {
    return {
      target,
      content: normalizedChunk,
    }
  }

  const boundaryIndex = normalizedChunk.indexOf(frontmatterSuffix, frontmatterPrefix.length)
  if (boundaryIndex === -1) {
    return {
      target,
      content: normalizedChunk,
    }
  }

  const metadataBlock = normalizedChunk.slice(frontmatterPrefix.length, boundaryIndex)
  const entryContent = normalizeMemoryContent(
    normalizedChunk.slice(boundaryIndex + frontmatterSuffix.length),
  )

  if (entryContent.length === 0) {
    return null
  }

  const metadata = parseFrontmatter(metadataBlock)
  return metadata ? { target, content: entryContent, metadata } : { target, content: entryContent }
}

function parseFrontmatter(frontmatter: string) {
  const metadata: Record<string, string> = {}

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    const separatorIndex = trimmed.indexOf(":")
    if (separatorIndex === -1) {
      continue
    }

    const rawKey = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()
    const key = unquoteYamlValue(rawKey)
    const value = unquoteYamlValue(rawValue)

    if (key.length === 0 || value.length === 0) {
      continue
    }

    metadata[key] = value
  }

  return normalizeMemoryMetadata(metadata)
}

function serializeMarkdownEntries(entries: MemoryEntry[]) {
  return entries
    .map((entry) => serializeMarkdownEntry(entry))
    .join(MEMORY_ENTRY_DELIMITER)
}

function serializeMarkdownEntry(entry: MemoryEntry) {
  const content = normalizeMemoryContent(entry.content)
  const metadata = normalizeMemoryMetadata(entry.metadata)

  if (!metadata) {
    return content
  }

  return `${FRONTMATTER_BOUNDARY}\n${serializeFrontmatter(metadata)}\n${FRONTMATTER_BOUNDARY}\n${content}`
}

function serializeFrontmatter(metadata: Record<string, string>) {
  return Object.entries(metadata)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}: ${quoteYamlValue(value)}`)
    .join("\n")
}

function quoteYamlValue(value: string) {
  return JSON.stringify(value)
}

function unquoteYamlValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      if (value.startsWith('"')) {
        return JSON.parse(value) as string
      }

      return value.slice(1, -1)
    } catch {
      return value.slice(1, -1)
    }
  }

  return value
}

async function withFileLock<T>(lockPath: string, operation: () => Promise<T>) {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + 2000

  while (true) {
    let handle: FileHandle | undefined
    try {
      handle = await open(lockPath, "wx")
      try {
        return await operation()
      } finally {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring memory lock: ${lockPath}`)
      }

      await delay(10)
    }
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
