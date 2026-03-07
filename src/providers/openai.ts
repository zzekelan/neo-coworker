import type OpenAI from "openai"
import type { Provider, ProviderEvent, ProviderTurnRequest } from "./types"

type OpenAIStreamEvent = OpenAI.Responses.ResponseStreamEvent
type OpenAIStreamRequest = Parameters<OpenAI["responses"]["stream"]>[0]
type OpenAIResponseInput = OpenAI.Responses.ResponseInput
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
        input: request.messages as OpenAIResponseInput,
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

        if (event.type === "response.function_call_arguments.delta") {
          const functionCall = functionCalls.get(event.item_id)
          if (functionCall == null) {
            continue
          }

          yield {
            type: "tool.call",
            callId: functionCall.callId,
            name: functionCall.name,
            inputText: event.delta,
          }
        }
      }
    },
  }
}
