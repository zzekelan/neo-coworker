import { countTokens } from "gpt-tokenizer/model/gpt-4o"
import type { ZodTypeAny } from "zod"
import type {
  ModelEvent,
  ModelMessage,
  ModelTool,
  ModelTurnRequest,
  ModelUsageEvent,
} from "../domain"

type UsageEstimateInput = {
  request: Pick<ModelTurnRequest, "system" | "messages" | "tools">
  outputEvents: Array<Extract<ModelEvent, { type: "text.delta" | "reasoning.delta" | "tool.call" }>>
}

export function estimateModelTurnUsage(input: UsageEstimateInput): ModelUsageEvent {
  return {
    type: "usage",
    source: "estimated",
    inputTokens: countSerializedTokens([
      `system:\n${input.request.system}`,
      ...input.request.messages.map(serializeMessage),
      ...input.request.tools.map(serializeTool),
    ]),
    outputTokens: countSerializedTokens(input.outputEvents.map(serializeOutputEvent)),
  }
}

function countSerializedTokens(parts: string[]) {
  const serialized = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n")

  if (!serialized) {
    return 0
  }

  return countTokens(serialized)
}

function serializeMessage(message: ModelMessage) {
  const parts = message.parts.map(serializeMessagePart).filter((part) => part.length > 0)

  if (parts.length === 0) {
    return `${message.role}:`
  }

  return `${message.role}:\n${parts.join("\n")}`
}

function serializeMessagePart(part: ModelMessage["parts"][number]) {
  switch (part.type) {
    case "text":
      return `text: ${part.text}`
    case "reasoning":
      return `reasoning: ${part.text}`
    case "tool_call":
      return `tool_call ${part.toolName} ${part.callId}: ${part.inputText}`
    case "tool_result":
      return `tool_result ${part.toolName} ${part.callId}: ${part.output}`
  }
}

function serializeTool(tool: ModelTool) {
  const lines = [`tool ${tool.name}`]

  if (tool.description) {
    lines.push(`description: ${tool.description}`)
  }

  if (tool.inputSchema) {
    lines.push(`input: ${describeSchema(tool.inputSchema)}`)
  }

  return lines.join("\n")
}

function serializeOutputEvent(
  event: Extract<ModelEvent, { type: "text.delta" | "reasoning.delta" | "tool.call" }>,
) {
  if (event.type === "text.delta") {
    return event.text
  }

  if (event.type === "reasoning.delta") {
    return `reasoning: ${event.text}`
  }

  return `tool_call ${event.name} ${event.callId}: ${event.inputText}`
}

function describeSchema(schema: ZodTypeAny): string {
  const typeName = schema._def.typeName as string

  switch (typeName) {
    case "ZodDefault":
    case "ZodNullable":
    case "ZodOptional":
      return describeSchema((schema as ZodTypeAny & { unwrap(): ZodTypeAny }).unwrap())
    case "ZodString":
      return "string"
    case "ZodNumber":
      return "number"
    case "ZodBoolean":
      return "boolean"
    case "ZodLiteral":
      return JSON.stringify((schema as ZodTypeAny & { _def: { value: unknown } })._def.value)
    case "ZodEnum":
      return (schema as ZodTypeAny & { _def: { values: string[] } })._def.values.join(" | ")
    case "ZodArray":
      return `Array<${describeSchema(
        (schema as ZodTypeAny & { _def: { type: ZodTypeAny } })._def.type,
      )}>`
    case "ZodObject": {
      const objectSchema = schema as ZodTypeAny & {
        shape: Record<string, ZodTypeAny>
      }
      const fields = Object.entries(objectSchema.shape).map(([key, value]) => {
        const suffix = value.isOptional() ? "?" : ""
        return `${key}${suffix}: ${describeSchema(value)}`
      })

      return `{ ${fields.join(", ")} }`
    }
    default:
      return typeName
  }
}
