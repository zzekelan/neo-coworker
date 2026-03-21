import type OpenAI from "openai"
import type { ModelEvent } from "../domain"

type FunctionCallMetadata = {
  callId: string
  name: string
}

type OpenAICompatibleToolCallState = {
  callId?: string
  name?: string
  inputText: string
  emitted: boolean
}

export function createOpenAIEventNormalizer() {
  const functionCalls = new Map<string, FunctionCallMetadata>()

  return {
    push(event: OpenAI.Responses.ResponseStreamEvent): ModelEvent[] {
      if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        rememberFunctionCall(functionCalls, event.item)
      }

      if (event.type === "response.output_text.delta") {
        return [{ type: "text.delta", text: event.delta }]
      }

      if (event.type === "response.function_call_arguments.done") {
        const functionCall = functionCalls.get(event.item_id)
        if (functionCall == null) {
          return []
        }

        return [
          {
            type: "tool.call",
            callId: functionCall.callId,
            name: functionCall.name,
            inputText: event.arguments,
          },
        ]
      }

      return []
    },
  }
}

export function createOpenAICompatibleEventNormalizer() {
  const toolCalls = new Map<number, OpenAICompatibleToolCallState>()

  return {
    push(chunk: OpenAI.Chat.ChatCompletionChunk): ModelEvent[] {
      const events: ModelEvent[] = []

      for (const choice of chunk.choices) {
        if (choice.delta.content) {
          events.push({ type: "text.delta", text: choice.delta.content })
        }

        for (const toolCall of choice.delta.tool_calls ?? []) {
          const state = toolCalls.get(toolCall.index) ?? {
            inputText: "",
            emitted: false,
          }

          if (toolCall.id) {
            state.callId = toolCall.id
          }

          if (toolCall.function?.name) {
            state.name = toolCall.function.name
          }

          if (toolCall.function?.arguments) {
            state.inputText += toolCall.function.arguments
          }

          toolCalls.set(toolCall.index, state)
        }

        if (choice.finish_reason === "tool_calls") {
          events.push(...flushOpenAICompatibleToolCalls(toolCalls))
        }
      }

      return events
    },
    flush() {
      return flushOpenAICompatibleToolCalls(toolCalls)
    },
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

function flushOpenAICompatibleToolCalls(
  toolCalls: Map<number, OpenAICompatibleToolCallState>,
): ModelEvent[] {
  const events: ModelEvent[] = []

  for (const [index, toolCall] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
    if (toolCall.emitted || !toolCall.name) {
      continue
    }

    events.push({
      type: "tool.call",
      callId: toolCall.callId ?? `tool_call_${index}`,
      name: toolCall.name,
      inputText: toolCall.inputText,
    })
    toolCall.emitted = true
  }

  return events
}
