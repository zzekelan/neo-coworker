import { countTokens } from "gpt-tokenizer/model/gpt-4o"

const MAX_TRACKED_FILES = 10
const MAX_RECOVERY_FILES = 5
const MAX_TOKENS_PER_FILE = 5_000
const MAX_FILE_RECOVERY_TOKENS = 25_000
const TRUNCATION_MARKER = "\n...[truncated]"

type RecentFileEntry = {
  path: string
  content: string
  tokenCount: number
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
    buildRecoveryReminder(sessionId: string) {
      const entries = (sessionEntries.get(sessionId) ?? []).slice().reverse()
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

      return [
        "<system-reminder>",
        "Recent file context:",
        "",
        ...selected.map((entry) => `### ${entry.path}\n${entry.content}`),
        "</system-reminder>",
      ].join("\n")
    },
  }
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
