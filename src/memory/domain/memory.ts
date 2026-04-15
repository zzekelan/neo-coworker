export const MEMORY_ENTRY_DELIMITER = "\n§\n"

export const MEMORY_CHAR_LIMITS = {
  agent: 2200,
  user: 1375,
} as const

export const MEMORY_FILES = {
  agent: "MEMORY.md",
  user: "USER.md",
} as const

export type MemoryTarget = keyof typeof MEMORY_FILES
export type MemoryMetadata = Record<string, string>

export type MemoryEntry = {
  target: MemoryTarget
  content: string
  metadata?: MemoryMetadata
}

export type MemoryMutationResult = {
  target: MemoryTarget
  entries: MemoryEntry[]
}

export type MemorySearchResult = MemoryMutationResult & {
  found: boolean
}

export type MemoryStore = {
  add(
    target: MemoryTarget,
    content: string,
    metadata?: MemoryMetadata,
  ): Promise<MemoryMutationResult>
  replace(target: MemoryTarget, search: string, newContent: string): Promise<MemorySearchResult>
  remove(target: MemoryTarget, search: string): Promise<MemorySearchResult>
  load(target: MemoryTarget): Promise<MemoryEntry[]>
  getSnapshot(): Promise<string>
}

export class MemoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryError"
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string) {
    super(message)
    this.name = "MemoryValidationError"
  }
}

export class MemoryOverflowError extends MemoryError {
  readonly target: MemoryTarget
  readonly currentSize: number
  readonly attemptedSize: number
  readonly limit: number

  constructor(input: {
    target: MemoryTarget
    currentSize: number
    attemptedSize: number
    limit: number
  }) {
    super(
      `Memory at ${input.currentSize}/${input.limit} chars. Attempted size ${input.attemptedSize} exceeds the limit.`,
    )
    this.name = "MemoryOverflowError"
    this.target = input.target
    this.currentSize = input.currentSize
    this.attemptedSize = input.attemptedSize
    this.limit = input.limit
  }
}

export class MemorySecurityError extends MemoryError {
  readonly target: MemoryTarget
  readonly threats: string[]

  constructor(target: MemoryTarget, threats: string[]) {
    super(
      `Memory content for ${target} was blocked by the security scan: ${threats.join(", ") || "unknown threat"}`,
    )
    this.name = "MemorySecurityError"
    this.target = target
    this.threats = [...threats]
  }
}

export class MemoryAmbiguousMatchError extends MemoryError {
  readonly target: MemoryTarget
  readonly searchTerm: string
  readonly matches: string[]

  constructor(target: MemoryTarget, searchTerm: string, matches: string[]) {
    super(`Multiple memory entries matched '${searchTerm}'. Be more specific.`)
    this.name = "MemoryAmbiguousMatchError"
    this.target = target
    this.searchTerm = searchTerm
    this.matches = [...matches]
  }
}

export function getMemoryCharLimit(target: MemoryTarget) {
  return MEMORY_CHAR_LIMITS[target]
}

export function getMemoryFileName(target: MemoryTarget) {
  return MEMORY_FILES[target]
}

export function normalizeMemoryContent(content: string) {
  return content.trim()
}

export function normalizeMemoryMetadata(metadata?: MemoryMetadata) {
  if (!metadata) {
    return undefined
  }

  const normalized = Object.entries(metadata)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))

  if (normalized.length === 0) {
    return undefined
  }

  return Object.fromEntries(normalized)
}

export function measureMemoryEntries(entries: Array<Pick<MemoryEntry, "content">>) {
  if (entries.length === 0) {
    return 0
  }

  return entries.map((entry) => entry.content).join(MEMORY_ENTRY_DELIMITER).length
}

export function previewMemoryEntry(entry: Pick<MemoryEntry, "content">, maxLength = 80) {
  const compact = entry.content.replace(/\s+/g, " ").trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`
}

export function areMemoryEntriesEquivalent(left: MemoryEntry, right: MemoryEntry) {
  return (
    left.content === right.content &&
    JSON.stringify(normalizeMemoryMetadata(left.metadata) ?? {}) ===
      JSON.stringify(normalizeMemoryMetadata(right.metadata) ?? {})
  )
}

export function renderMemorySnapshot(input: {
  agentEntries: MemoryEntry[]
  userEntries: MemoryEntry[]
}) {
  const sections = [
    renderMemoryBlock("agent", input.agentEntries),
    renderMemoryBlock("user", input.userEntries),
  ].filter((section): section is string => section.length > 0)

  return sections.join("\n\n")
}

export function renderMemoryBlock(target: MemoryTarget, entries: MemoryEntry[]) {
  if (entries.length === 0) {
    return ""
  }

  const current = measureMemoryEntries(entries)
  const limit = getMemoryCharLimit(target)
  const percentage = Math.min(100, Math.floor((current / limit) * 100))
  const header =
    target === "user"
      ? `USER PROFILE (who the user is) [${percentage}% — ${current}/${limit} chars]`
      : `MEMORY (your personal notes) [${percentage}% — ${current}/${limit} chars]`

  return `${"═".repeat(46)}\n${header}\n${"═".repeat(46)}\n${entries
    .map((entry) => entry.content)
    .join(MEMORY_ENTRY_DELIMITER)}`
}
