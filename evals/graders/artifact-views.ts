import type { EvalRunArtifact } from "../schemas/artifact"

export type TranscriptPartView = {
  kind: string
  text: string
  toolName: string | null
  output: string | null
  isError: boolean
}

export type TranscriptMessageView = {
  index: number
  role: string | null
  partKinds: string[]
  texts: string[]
  combinedText: string
  toolNames: string[]
  toolResults: Array<{
    toolName: string
    output: string
  }>
}

export type PromptAssemblyEventView = {
  index: number
  sequence: number
  turnKey: string | null
  catalogSkillNames: string[]
  activeSkillNames: string[]
  activeSkillCount: number | null
  recoveryFilePaths: string[]
  systemPromptHash: string | null
  systemPromptLength: number | null
  systemReminderHash: string | null
  systemReminderLength: number | null
}

export function readTimelineContentViews(artifact: EvalRunArtifact): TranscriptMessageView[] {
  return readContentEntries(artifact).map((message, index) => {
    const role = readStringField(message, "role")
    const parts = readTranscriptParts(message)
    const texts = parts.map((part) => part.text).filter((text) => text.length > 0)
    const toolNames = [...new Set(parts.map((part) => part.toolName).filter(isNonEmptyString))]
    const toolResults = parts
      .filter((part) => part.kind === "tool_result" && part.toolName && part.output !== null)
      .map((part) => ({
        toolName: part.toolName!,
        output: part.output!,
      }))

    return {
      index,
      role,
      partKinds: parts.flatMap((part) => (part.isError ? [part.kind, "error"] : [part.kind])),
      texts,
      combinedText: texts.join("\n"),
      toolNames,
      toolResults,
    }
  })
}

export function readTranscriptViews(artifact: EvalRunArtifact): TranscriptMessageView[] {
  return readTimelineContentViews(artifact)
}

export function readPromptAssemblyEvents(artifact: EvalRunArtifact): PromptAssemblyEventView[] {
  const events = artifact.trace?.events ?? []

  return events
    .filter((event) => event.eventType === "model.prompt.assembled")
    .map((event, index) => ({
      index,
      sequence: event.sequence,
      turnKey: readStringField(event.data, "turnKey"),
      catalogSkillNames: readStringArrayField(event.data, "catalogSkillNames"),
      activeSkillNames: readStringArrayField(event.data, "activeSkillNames"),
      activeSkillCount: readNumberField(event.data, "activeSkillCount"),
      recoveryFilePaths: readStringArrayField(event.data, "recoveryFilePaths"),
      systemPromptHash: readStringField(event.data, "systemPromptHash"),
      systemPromptLength: readNumberField(event.data, "systemPromptLength"),
      systemReminderHash: readStringField(event.data, "systemReminderHash"),
      systemReminderLength: readNumberField(event.data, "systemReminderLength"),
    }))
}

export function readRunTraceEvents(artifact: EvalRunArtifact, runIndex?: number) {
  if (runIndex === undefined) {
    return artifact.trace?.events ?? []
  }

  return artifact.runs[runIndex]?.trace?.events ?? []
}

export function readArtifactRuns(artifact: EvalRunArtifact) {
  return artifact.runs
}

export function findOrderedMatches(
  observed: string[],
  expected: string[],
) {
  const missing: string[] = []
  let observedIndex = 0

  for (const expectedValue of expected) {
    let matched = false

    while (observedIndex < observed.length) {
      if (observed[observedIndex]!.includes(expectedValue)) {
        matched = true
        observedIndex += 1
        break
      }

      observedIndex += 1
    }

    if (!matched) {
      missing.push(expectedValue)
    }
  }

  return {
    pass: missing.length === 0,
    missing,
  }
}

function readTranscriptParts(message: unknown): TranscriptPartView[] {
  if (!isRecord(message) || !Array.isArray(message.parts)) {
    return []
  }

  return message.parts
    .filter(isRecord)
    .map((part) => {
      const kind = readStringField(part, "kind") ?? "unknown"
      const text = readStringField(part, "text") ?? ""
      const data = isRecord(part.data) ? part.data : null
      const toolName = readStringField(data, "toolName") ?? readStringField(data, "name")
      const output = readStringField(data, "output") ?? (kind === "tool_result" ? text : null)
      const isError = readBooleanField(data, "isError") ?? (kind === "error")

      return {
        kind,
        text,
        toolName,
        output,
        isError,
      }
    })
}

function readContentEntries(artifact: EvalRunArtifact) {
  if (Array.isArray(artifact.timeline) && artifact.timeline.length > 0) {
    return artifact.timeline
  }

  if (Array.isArray(artifact.transcript)) {
    return artifact.transcript
  }

  return []
}

function readStringArrayField(value: unknown, field: string) {
  if (!isRecord(value) || !Array.isArray(value[field])) {
    return []
  }

  return value[field].filter(isNonEmptyString)
}

function readStringField(value: unknown, field: string) {
  if (!isRecord(value) || !isNonEmptyString(value[field])) {
    return null
  }

  return value[field]
}

function readNumberField(value: unknown, field: string) {
  if (!isRecord(value) || typeof value[field] !== "number" || Number.isNaN(value[field])) {
    return null
  }

  return value[field]
}

function readBooleanField(value: unknown, field: string) {
  if (!isRecord(value) || typeof value[field] !== "boolean") {
    return null
  }

  return value[field]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}
