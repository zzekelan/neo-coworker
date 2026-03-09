import type OpenAI from "openai"
import type {
  Provider,
  ProviderEvent,
  ProviderMessage,
  ProviderToolCallPart,
  ProviderToolResultPart,
  ProviderTurnRequest,
} from "./types"

type OpenAIStreamEvent = OpenAI.Responses.ResponseStreamEvent
type OpenAIStreamRequest = Parameters<OpenAI["responses"]["stream"]>[0]
type OpenAIResponseInput = OpenAI.Responses.ResponseInput
type OpenAIResponseInputItem = OpenAI.Responses.ResponseInputItem
type OpenAITools = OpenAI.Responses.Tool[]

type FunctionCallMetadata = {
  callId: string
  name: string
}

type OpenAIClient = {
  responses: {
    stream(
      input: OpenAIStreamRequest,
      options?: OpenAI.RequestOptions,
    ): AsyncIterable<OpenAIStreamEvent>
  }
}

function rememberFunctionCall(
  functionCalls: Map<string, FunctionCallMetadata>,
  item: OpenAI.Responses.ResponseOutputItem,
) {
  if (item.type !== "function_call" || item.id == null) {
    return
  }

  functionCalls.set(item.id, {
    callId: item.call_id,
    name: item.name,
  })
}

function readMessageText(message: ProviderMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

function toResponseInput(message: ProviderMessage): OpenAIResponseInputItem[] {
  if (message.role === "tool") {
    return message.parts.flatMap((part) =>
      part.type === "tool_result"
        ? [
            {
              type: "function_call_output" as const,
              call_id: part.callId,
              output: part.output,
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

function toResponseInputs(messages: ProviderMessage[]): OpenAIResponseInput {
  return messages.flatMap((message) => toResponseInput(message))
}

export function createOpenAIProvider(input: {
  model: string
  client: OpenAIClient
}): Provider {
  return {
    async *streamTurn(
      request: ProviderTurnRequest,
    ): AsyncGenerator<ProviderEvent, void, void> {
      const stream = input.client.responses.stream(
        {
          model: input.model,
          input: toResponseInputs(request.messages),
          instructions: request.system,
          tools: request.tools as OpenAITools,
        },
        { signal: request.signal },
      )
      const functionCalls = new Map<string, FunctionCallMetadata>()

      for await (const event of stream) {
        if (
          event.type === "response.output_item.added" ||
          event.type === "response.output_item.done"
        ) {
          rememberFunctionCall(functionCalls, event.item)
        }

        if (event.type === "response.output_text.delta") {
          yield { type: "text.delta", text: event.delta }
        }

        if (event.type === "response.function_call_arguments.done") {
          const functionCall = functionCalls.get(event.item_id)
          if (functionCall == null) {
            continue
          }

          yield {
            type: "tool.call",
            callId: functionCall.callId,
            name: functionCall.name,
            inputText: event.arguments,
          }
        }
      }
    },
  }
}
