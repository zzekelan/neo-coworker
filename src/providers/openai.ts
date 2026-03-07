import type { Provider, ProviderEvent, ProviderTurnRequest } from "./types"

type OpenAIStreamEvent =
  | {
      type: "response.output_text.delta"
      delta: string
    }
  | {
      type: "response.function_call_arguments.delta"
      item_id: string
      name: string
      delta: string
    }
  | {
      type: string
    }

type OpenAIClient = {
  responses: {
    stream(input: {
      model: string
      input: unknown[]
      instructions: string
      tools: unknown[]
      signal: AbortSignal
    }): AsyncIterable<OpenAIStreamEvent> | Promise<AsyncIterable<OpenAIStreamEvent>>
  }
}

export function createOpenAIProvider(input: {
  model: string
  client: OpenAIClient
}): Provider {
  return {
    async *streamTurn(
      request: ProviderTurnRequest,
    ): AsyncGenerator<ProviderEvent, void, void> {
      const stream = await input.client.responses.stream({
        model: input.model,
        input: request.messages,
        instructions: request.system,
        tools: request.tools,
        signal: request.signal,
      })

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield { type: "text.delta", text: event.delta }
        }

        if (event.type === "response.function_call_arguments.delta") {
          yield {
            type: "tool.call",
            callId: event.item_id,
            name: event.name,
            inputText: event.delta,
          }
        }
      }
    },
  }
}
