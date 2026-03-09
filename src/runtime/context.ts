import type { StoredPart, TranscriptMessage } from "../storage"

type MessagePart = {
  type: string
  text?: string
}

type Message = {
  role: string
  parts: MessagePart[]
  content?: string
}

type Tool = {
  name: string
  description: string
}

export function buildModelInput(input: {
  systemPrompt: string
  activeSkillInstructions: string[]
  tools: Tool[]
  messages: Message[]
}) {
  const toolList = input.tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n")
  const skillText = input.activeSkillInstructions.join("\n\n")

  return {
    system: [input.systemPrompt, skillText, "Available tools:", toolList]
      .filter(Boolean)
      .join("\n\n"),
    messages: input.messages,
  }
}

export function buildTranscriptMessages(transcript: TranscriptMessage[]): Message[] {
  return transcript
    .map((message) => ({
      role: message.role === "synthetic" ? "assistant" : message.role,
      content: message.parts.map(renderTranscriptPart).filter(Boolean).join("\n\n"),
      parts: [],
    }))
    .filter((message) => message.content.length > 0)
}

function renderTranscriptPart(part: StoredPart) {
  switch (part.kind) {
    case "text":
    case "reasoning":
    case "step_start":
    case "step_finish":
    case "patch":
      return part.text ?? ""
    case "tool_call":
      return renderToolCallPart(part)
    case "tool_result":
      return renderToolResultPart(part)
    case "error":
      return `Error: ${part.text ?? "unknown error"}`
  }
}

function renderToolCallPart(part: StoredPart) {
  const data = readObject(part.data)
  const toolName = readString(data, "toolName") ?? "unknown"
  const callId = readString(data, "callId")
  const inputText = readString(data, "inputText")

  return [`Tool call ${toolName}${callId ? ` (${callId})` : ""}`, inputText]
    .filter(Boolean)
    .join(": ")
}

function renderToolResultPart(part: StoredPart) {
  const data = readObject(part.data)
  const toolName = readString(data, "toolName") ?? "unknown"
  const callId = readString(data, "callId")
  const text = part.text ?? readString(data, "output") ?? ""

  return [`Tool result ${toolName}${callId ? ` (${callId})` : ""}`, text]
    .filter(Boolean)
    .join(": ")
}

function readObject(value: unknown) {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function readString(value: Record<string, unknown> | null, key: string) {
  return typeof value?.[key] === "string" ? (value[key] as string) : null
}
