import type OpenAI from "openai"
import {
  type ModelMessage,
} from "../../domain"
import type { Provider } from "../../application/ports/provider"
import { createOpenAIEventNormalizer } from "../normalize"

type OpenAIStreamEvent = OpenAI.Responses.ResponseStreamEvent
type OpenAIStreamRequest = Parameters<OpenAI["responses"]["stream"]>[0]
type OpenAIResponseInput = OpenAI.Responses.ResponseInput
type OpenAIResponseInputItem = OpenAI.Responses.ResponseInputItem
type OpenAITools = OpenAI.Responses.Tool[]

type OpenAIClient = {
  responses: {
    stream(
      input: OpenAIStreamRequest,
      options?: OpenAI.RequestOptions,
    ): AsyncIterable<OpenAIStreamEvent>
  }
}

function readMessageText(message: ModelMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

function toResponseInput(message: ModelMessage): OpenAIResponseInputItem[] {
  if (message.role === "tool") {
    return message.parts.flatMap((part) =>
      part.type === "tool_result"
        ? [
            {
              type: "function_call_output" as const,
              call_id: part.callId,
              output: serializeToolResult(part),
            },
          ]
        : [],
    )
  }

  const items: OpenAIResponseInputItem[] = []
  const content = readMessageText(message)
  if (content) {
    items.push({
      type: "message",
      role: message.role,
      content,
    })
  }

  if (message.role !== "assistant") {
    return items
  }

  for (const part of message.parts) {
    if (part.type !== "tool_call") {
      continue
    }

    items.push({
      type: "function_call",
      call_id: part.callId,
      name: part.toolName,
      arguments: part.inputText,
    })
  }

  return items
}

function serializeToolResult(part: Extract<ModelMessage["parts"][number], { type: "tool_result" }>) {
  return part.isError ? `[error] ${part.output}` : part.output
}

function toResponseInputs(messages: ModelMessage[]): OpenAIResponseInput {
  return messages.flatMap((message) => toResponseInput(message))
}

export function createOpenAIProvider(input: {
  model: string
  client: OpenAIClient
}): Provider {
  return {
    async *streamTurn(request) {
      const stream = input.client.responses.stream(
        {
          model: input.model,
          input: toResponseInputs(request.messages),
          instructions: request.system,
          parallel_tool_calls: true,
          ...(request.temperature !== undefined && { temperature: request.temperature }),
          tools: request.tools as OpenAITools,
        },
        { signal: request.signal },
      )
      const normalize = createOpenAIEventNormalizer()

      for await (const event of stream) {
        yield* normalize.push(event)
      }
    },
  }
}
