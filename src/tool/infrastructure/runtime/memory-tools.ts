import { z } from "zod"
import {
  throwIfToolAborted,
  type ToolDefinition,
  type ToolExecutionResult,
} from "../../domain"

export type MemoryToolTarget = "agent" | "user"

export type MemoryToolMetadata = Record<string, string>

export type MemoryToolEntry = {
  target: MemoryToolTarget
  content: string
  metadata?: MemoryToolMetadata
}

export type MemoryToolMutationResult = {
  target: MemoryToolTarget
  entries: MemoryToolEntry[]
}

export type MemoryToolSearchResult = MemoryToolMutationResult & {
  found: boolean
}

export type MemoryToolStore = {
  add(
    target: MemoryToolTarget,
    content: string,
    metadata?: MemoryToolMetadata,
  ): Promise<MemoryToolMutationResult> | MemoryToolMutationResult
  replace(
    target: MemoryToolTarget,
    search: string,
    replacement: string,
  ): Promise<MemoryToolSearchResult> | MemoryToolSearchResult
  remove(target: MemoryToolTarget, search: string): Promise<MemoryToolSearchResult> | MemoryToolSearchResult
  load(target: MemoryToolTarget): Promise<MemoryToolEntry[]> | MemoryToolEntry[]
}

const MemoryTargetSchema = z.enum(["agent", "user"]).describe(
  "Which persistent memory store to use. `agent` is your own long-lived notes about the environment, project conventions, and tool quirks. `user` is the user's long-lived profile, preferences, and personal context.",
)

const MemoryMetadataSchema = z.record(z.string()).optional().describe(
  "Optional flat string metadata for the entry, for example `{ source: 'workspace', scope: 'tooling' }`. Use sparingly and keep both keys and values short.",
)

const MemoryAddArgsSchema = z.object({
  target: MemoryTargetSchema,
  content: z.string().trim().min(1, "Content must not be empty").describe(
    "Stable information to save for future sessions. Good examples: a user preference, an environment fact, or a project convention. Do not store temporary task progress, TODOs, or timeline summaries.",
  ),
  metadata: MemoryMetadataSchema,
}).describe(
  "Persist a new durable memory entry for future sessions. Use this proactively for stable facts that will still matter later, such as user preferences, environment facts, or project conventions.",
)

const MemoryReplaceArgsSchema = z.object({
  target: MemoryTargetSchema,
  search: z.string().trim().min(1, "Search text must not be empty").describe(
    "Short unique substring from the existing memory entry you want to update. Use `memory_view` first if you are unsure of the current wording.",
  ),
  replacement: z.string().trim().min(1, "Replacement must not be empty").describe(
    "The full new text that should replace the matched memory entry.",
  ),
}).describe(
  "Update an existing persistent memory entry by matching a short unique substring of its current text. Use this when a remembered fact changed or needs correction.",
)

const MemoryRemoveArgsSchema = z.object({
  target: MemoryTargetSchema,
  search: z.string().trim().min(1, "Search text must not be empty").describe(
    "Short unique substring from the memory entry you want to delete. Use `memory_view` first if multiple entries might match.",
  ),
}).describe(
  "Delete a stale or incorrect persistent memory entry by matching a short unique substring. Use this when a saved fact is obsolete, wrong, or should be forgotten.",
)

const MemoryViewArgsSchema = z.object({
  target: MemoryTargetSchema,
}).describe(
  "Inspect the current live contents of one persistent memory store. Use this before replacing or removing an entry when you need the exact wording or want to confirm what is already remembered.",
)

export function createMemoryTools(input: { memory: MemoryToolStore }): ToolDefinition[] {
  return [
    createMemoryAddTool(input),
    createMemoryReplaceTool(input),
    createMemoryRemoveTool(input),
    createMemoryViewTool(input),
  ]
}

function createMemoryAddTool(input: { memory: MemoryToolStore }): ToolDefinition {
  return {
    name: "memory_add",
    description:
      "Save a new durable memory entry for future sessions. Use this for stable user preferences, environment facts, or project conventions that will likely matter again. Do not save temporary task state or session-only progress.",
    inputSchema: MemoryAddArgsSchema,
    concurrency: "mutating",
    isCompressible: true,
    usageGuidance:
      "Prefer concise, durable facts over verbose notes. Save stable information proactively, but skip temporary task progress and anything that is easy to rediscover.",
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { target, content, metadata } = MemoryAddArgsSchema.parse(toolInput.args)

      try {
        const result = await input.memory.add(target, content, metadata)
        throwIfToolAborted(toolInput.signal)

        return {
          output: `Saved entry to ${formatMemoryTarget(target)}.\n\n${formatMemoryContents(target, result.entries)}`,
          metadata: {
            operation: "add",
            target: result.target,
            entryCount: result.entries.length,
          },
        }
      } catch (error) {
        return handleMemoryError(error)
      }
    },
  }
}

function createMemoryReplaceTool(input: { memory: MemoryToolStore }): ToolDefinition {
  return {
    name: "memory_replace",
    description:
      "Update an existing durable memory entry by matching a short unique substring of its current text. Use this when a remembered fact changed, needs refinement, or the user corrected something you previously stored.",
    inputSchema: MemoryReplaceArgsSchema,
    concurrency: "mutating",
    isCompressible: true,
    usageGuidance:
      "Use `memory_view` first if you are not sure which entry currently exists. Keep the search string short but specific enough to identify only one entry.",
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { target, search, replacement } = MemoryReplaceArgsSchema.parse(toolInput.args)

      try {
        const result = await input.memory.replace(target, search, replacement)
        throwIfToolAborted(toolInput.signal)

        if (!result.found) {
          return {
            output:
              `No entry in ${formatMemoryTarget(target)} matched ${JSON.stringify(search)}. ` +
              `Use memory_view first to inspect current contents.\n\n${formatMemoryContents(target, result.entries)}`,
            isError: true,
            metadata: {
              operation: "replace",
              target: result.target,
              found: false,
              entryCount: result.entries.length,
              search,
            },
          }
        }

        return {
          output: `Updated matching entry in ${formatMemoryTarget(target)}.\n\n${formatMemoryContents(target, result.entries)}`,
          metadata: {
            operation: "replace",
            target: result.target,
            found: true,
            entryCount: result.entries.length,
            search,
          },
        }
      } catch (error) {
        return handleMemoryError(error)
      }
    },
  }
}

function createMemoryRemoveTool(input: { memory: MemoryToolStore }): ToolDefinition {
  return {
    name: "memory_remove",
    description:
      "Delete a durable memory entry by matching a short unique substring of its current text. Use this when a memory is stale, incorrect, or no longer useful for future sessions.",
    inputSchema: MemoryRemoveArgsSchema,
    concurrency: "mutating",
    isCompressible: true,
    usageGuidance:
      "Use `memory_view` first when you need to confirm the exact entry or when multiple memories might mention similar text.",
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { target, search } = MemoryRemoveArgsSchema.parse(toolInput.args)

      try {
        const result = await input.memory.remove(target, search)
        throwIfToolAborted(toolInput.signal)

        if (!result.found) {
          return {
            output:
              `No entry in ${formatMemoryTarget(target)} matched ${JSON.stringify(search)}. ` +
              `Use memory_view first to inspect current contents.\n\n${formatMemoryContents(target, result.entries)}`,
            isError: true,
            metadata: {
              operation: "remove",
              target: result.target,
              found: false,
              entryCount: result.entries.length,
              search,
            },
          }
        }

        return {
          output: `Removed matching entry from ${formatMemoryTarget(target)}.\n\n${formatMemoryContents(target, result.entries)}`,
          metadata: {
            operation: "remove",
            target: result.target,
            found: true,
            entryCount: result.entries.length,
            search,
          },
        }
      } catch (error) {
        return handleMemoryError(error)
      }
    },
  }
}

function createMemoryViewTool(input: { memory: MemoryToolStore }): ToolDefinition {
  return {
    name: "memory_view",
    description:
      "Read the current live contents of one persistent memory store. Use this before replacing or removing entries, or whenever you need to confirm what is already remembered across sessions.",
    inputSchema: MemoryViewArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    usageGuidance:
      "Prefer this before `memory_replace` or `memory_remove` when you need the current wording of stored memories.",
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { target } = MemoryViewArgsSchema.parse(toolInput.args)

      try {
        const entries = await input.memory.load(target)
        throwIfToolAborted(toolInput.signal)

        return {
          output: formatMemoryContents(target, entries),
          metadata: {
            operation: "view",
            target,
            entryCount: entries.length,
          },
        }
      } catch (error) {
        return handleMemoryError(error)
      }
    },
  }
}

function formatMemoryTarget(target: MemoryToolTarget) {
  return target === "user" ? "user memory" : "agent memory"
}

function formatMemoryTitle(target: MemoryToolTarget) {
  return target === "user" ? "User memory" : "Agent memory"
}

function formatMemoryContents(target: MemoryToolTarget, entries: MemoryToolEntry[]) {
  const title = formatMemoryTitle(target)

  if (entries.length === 0) {
    return `${title} is empty.`
  }

  const countLabel = entries.length === 1 ? "entry" : "entries"

  return `${title} (${entries.length} ${countLabel}):\n${entries.map(formatMemoryEntry).join("\n\n")}`
}

function formatMemoryEntry(entry: MemoryToolEntry, index: number) {
  const lines = entry.content.split(/\r?\n/g)
  const [firstLine = "", ...rest] = lines
  const formatted = [`${index + 1}. ${firstLine}`, ...rest.map((line) => `   ${line}`)]

  if (entry.metadata && Object.keys(entry.metadata).length > 0) {
    formatted.push(`   metadata: ${formatMetadata(entry.metadata)}`)
  }

  return formatted.join("\n")
}

function formatMetadata(metadata: MemoryToolMetadata) {
  return Object.entries(metadata)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ")
}

function handleMemoryError(error: unknown): ToolExecutionResult {
  const result = toKnownMemoryErrorResult(error)
  if (result) {
    return result
  }

  throw error
}

function toKnownMemoryErrorResult(error: unknown): ToolExecutionResult | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }

  const details = asRecord(error)

  switch (error.name) {
    case "MemoryValidationError":
      return {
        output: error.message,
        isError: true,
        metadata: {
          code: "memory_validation_error",
        },
      }
    case "MemoryOverflowError":
      return {
        output: error.message,
        isError: true,
        metadata: {
          code: "memory_overflow_error",
          target: readString(details, "target"),
          currentSize: readNumber(details, "currentSize"),
          attemptedSize: readNumber(details, "attemptedSize"),
          limit: readNumber(details, "limit"),
        },
      }
    case "MemorySecurityError":
      return {
        output: error.message,
        isError: true,
        metadata: {
          code: "memory_security_error",
          target: readString(details, "target"),
          threats: readStringArray(details, "threats"),
        },
      }
    case "MemoryAmbiguousMatchError": {
      const searchTerm = readString(details, "searchTerm")
      const matches = readStringArray(details, "matches")
      return {
        output: [
          error.message,
          searchTerm ? `Search term: ${JSON.stringify(searchTerm)}` : undefined,
          matches.length > 0 ? `Matches:\n- ${matches.join("\n- ")}` : undefined,
        ].filter((value): value is string => Boolean(value)).join("\n\n"),
        isError: true,
        metadata: {
          code: "memory_ambiguous_match_error",
          target: readString(details, "target"),
          searchTerm,
          matches,
        },
      }
    }
    default:
      return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function readString(record: Record<string, unknown> | undefined, key: string) {
  return typeof record?.[key] === "string" ? record[key] as string : undefined
}

function readNumber(record: Record<string, unknown> | undefined, key: string) {
  return typeof record?.[key] === "number" ? record[key] as number : undefined
}

function readStringArray(record: Record<string, unknown> | undefined, key: string) {
  return Array.isArray(record?.[key])
    ? record[key].filter((value): value is string => typeof value === "string")
    : []
}
