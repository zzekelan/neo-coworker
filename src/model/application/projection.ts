import type {
  ModelActiveSkill,
  ModelMessage,
  ModelMessagePart,
  ModelProjectionInput,
  ModelSkillCatalogEntry,
  ModelTextPart,
  ModelTranscriptMessage,
  ModelTranscriptPart,
  ModelTurnRequest,
} from "../domain"

export const SYSTEM_REMINDER_NOTICE =
  "Tool results and user messages may include <system-reminder> tags. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear."

export type ModelPromptSections = {
  baseSystemPrompt: string
  systemReminderNotice: string
  systemReminderMessages: string[]
}

export function buildModelTurnInput(input: ModelProjectionInput) {
  const sections = buildModelPromptSections(input)
  const messages = buildTranscriptMessages(input.transcript)
  messages.push(...buildSystemReminderMessages(sections.systemReminderMessages))

  return {
    system: buildStaticSystemPrompt(sections),
    messages,
    tools: input.tools,
  }
}

export function buildModelPromptSections(
  input: Pick<ModelProjectionInput, "systemPrompt" | "skillCatalog" | "activeSkills" | "systemReminders">,
): ModelPromptSections {
  return {
    baseSystemPrompt: input.systemPrompt,
    systemReminderNotice: SYSTEM_REMINDER_NOTICE,
    systemReminderMessages: buildSystemReminderTexts(input),
  }
}

export function buildStaticSystemPrompt(
  input: Pick<ModelPromptSections, "baseSystemPrompt" | "systemReminderNotice">,
) {
  return [input.baseSystemPrompt, input.systemReminderNotice].join("\n\n")
}

export function projectModelTurn(
  input: ModelProjectionInput & Pick<ModelTurnRequest, "signal">,
): ModelTurnRequest {
  return {
    ...buildModelTurnInput(input),
    signal: input.signal,
  }
}

export function buildTranscriptMessages(transcript: ModelTranscriptMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  const resolvedToolCallIds = collectResolvedToolCallIds(transcript)

  for (const message of transcript) {
    const role = message.role === "synthetic" ? "assistant" : message.role

    if (role === "assistant") {
      messages.push(...buildAssistantMessages(message, resolvedToolCallIds))
      continue
    }

    if (role !== "user" && role !== "system") {
      continue
    }

    const parts = message.parts
      .map(renderTextPart)
      .filter((part): part is ModelTextPart => part !== null)

    if (parts.length === 0) {
      continue
    }

    messages.push({
      role,
      parts,
    })
  }

  return messages
}

function buildAssistantMessages(
  message: ModelTranscriptMessage,
  resolvedToolCallIds: ReadonlySet<string>,
): ModelMessage[] {
  const assistantParts: ModelMessagePart[] = []
  const toolMessages: ModelMessage[] = []

  for (const part of message.parts) {
    if (isTextPart(part.kind)) {
      const rendered = renderTextPart(part)
      if (rendered) {
        assistantParts.push(rendered)
      }
      continue
    }

    if (part.kind === "tool_call") {
      const rendered = renderToolCallPart(part)
      if (resolvedToolCallIds.has(createResolvedToolCallKey(message, rendered.callId))) {
        assistantParts.push(rendered)
      }
      continue
    }

    if (part.kind === "tool_result") {
      toolMessages.push({
        role: "tool",
        parts: [renderToolResultPart(part)],
      })
      continue
    }

    const errorAsToolResult = renderToolErrorPart(part)
    if (errorAsToolResult) {
      toolMessages.push({
        role: "tool",
        parts: [errorAsToolResult],
      })
      continue
    }

    const rendered = renderTextPart(part)
    if (rendered) {
      assistantParts.push(rendered)
    }
  }

  const messages: ModelMessage[] = []
  if (assistantParts.length > 0) {
    messages.push({
      role: "assistant",
      parts: assistantParts,
    })
  }

  messages.push(...toolMessages)
  return messages
}

function collectResolvedToolCallIds(transcript: ModelTranscriptMessage[]) {
  const resolvedToolCallIds = new Set<string>()

  for (const message of transcript) {
    for (const part of message.parts) {
      if (part.kind === "tool_result") {
        const rendered = renderToolResultPart(part)
        resolvedToolCallIds.add(createResolvedToolCallKey(message, rendered.callId))
        continue
      }

      const rendered = renderToolErrorPart(part)
      if (rendered) {
        resolvedToolCallIds.add(createResolvedToolCallKey(message, rendered.callId))
      }
    }
  }

  return resolvedToolCallIds
}

function createResolvedToolCallKey(message: ModelTranscriptMessage, callId: string) {
  const runId =
    "runId" in message && typeof message.runId === "string" ? message.runId : null

  return runId ? `${runId}:${callId}` : callId
}

function isTextPart(kind: ModelTranscriptPart["kind"]) {
  return (
    kind === "text" ||
    kind === "reasoning" ||
    kind === "step_start" ||
    kind === "step_finish" ||
    kind === "patch"
  )
}

function renderTextPart(part: ModelTranscriptPart): ModelTextPart | null {
  switch (part.kind) {
    case "text":
    case "reasoning":
    case "step_start":
    case "step_finish":
    case "patch":
      return part.text ? { type: "text", text: part.text } : null
    case "error":
      return {
        type: "text",
        text: `Error: ${part.text ?? "unknown error"}`,
      }
    default:
      return null
  }
}

function renderToolCallPart(part: ModelTranscriptPart) {
  const data = readObject(part.data)
  return {
    type: "tool_call" as const,
    toolName: readString(data, "toolName") ?? "unknown",
    callId: readString(data, "callId") ?? "unknown_call",
    inputText: readString(data, "inputText") ?? "",
  }
}

function renderToolResultPart(part: ModelTranscriptPart) {
  const data = readObject(part.data)
  return {
    type: "tool_result" as const,
    toolName: readString(data, "toolName") ?? "unknown",
    callId: readString(data, "callId") ?? "unknown_call",
    output: part.text ?? readString(data, "output") ?? "",
  }
}

function renderToolErrorPart(part: ModelTranscriptPart) {
  if (part.kind !== "error") {
    return null
  }

  const data = readObject(part.data)
  if (readString(data, "source") !== "tool") {
    return null
  }

  return {
    type: "tool_result" as const,
    toolName: readString(data, "toolName") ?? "unknown",
    callId: readString(data, "callId") ?? "unknown_call",
    output: `Error: ${part.text ?? "unknown error"}`,
    isError: true,
  }
}

function readObject(value: unknown) {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readString(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "string" ? (value[key] as string) : null
}

export function buildSystemReminderPayloadText(messages: string[]) {
  return messages.length > 0 ? messages.join("\n\n") : null
}

function buildSystemReminderMessages(messages: string[]): ModelMessage[] {
  return messages.map((text) => ({
    role: "user",
    parts: [{ type: "text", text }],
  }))
}

function buildSystemReminderTexts(
  input: Pick<ModelProjectionInput, "skillCatalog" | "activeSkills" | "systemReminders">,
) {
  if (input.systemReminders && input.systemReminders.length > 0) {
    return input.systemReminders.filter((message): message is string => message.trim().length > 0)
  }

  const legacyReminder = renderSystemReminderMessage(input.skillCatalog, input.activeSkills)
  return legacyReminder ? [legacyReminder] : []
}

function renderSystemReminderMessage(skillCatalog: ModelSkillCatalogEntry[], activeSkills: ModelActiveSkill[]) {
  const sections = [renderSkillCatalogSection(skillCatalog), renderActiveSkillSection(activeSkills)].filter(
    (section): section is string => section !== null,
  )

  if (sections.length === 0) {
    return null
  }

  return `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`
}

function renderSkillCatalogSection(skillCatalog: ModelSkillCatalogEntry[]) {
  if (skillCatalog.length === 0) {
    return null
  }

  return [
    "Skill catalog:",
    ...skillCatalog.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`),
  ].join("\n")
}

function renderActiveSkillSection(activeSkills: ModelActiveSkill[]) {
  if (activeSkills.length === 0) {
    return null
  }

  return [
    "Active skill instructions:",
    ...activeSkills.map((skill) => `## ${skill.name}\n${skill.instructions}`),
  ].join("\n\n")
}
