import type { EvalRunArtifact } from "../schemas/artifact"

export type TranscriptPartView = {
  kind: string
  text: string
  toolName: string | null
  output: string | null
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
  systemPromptHash: string | null
  systemPromptLength: number | null
  systemReminderHash: string | null
  systemReminderLength: number | null
}

export function readTranscriptViews(artifact: EvalRunArtifact): TranscriptMessageView[] {
  if (!Array.isArray(artifact.transcript)) {
    return []
  }

  return artifact.transcript.map((message, index) => {
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
      partKinds: parts.map((part) => part.kind),
      texts,
      combinedText: texts.join("\n"),
      toolNames,
      toolResults,
    }
  })
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
      systemPromptHash: readStringField(event.data, "systemPromptHash"),
      systemPromptLength: readNumberField(event.data, "systemPromptLength"),
      systemReminderHash: readStringField(event.data, "systemReminderHash"),
      systemReminderLength: readNumberField(event.data, "systemReminderLength"),
    }))
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

      return {
        kind,
        text,
        toolName,
        output,
      }
    })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}
