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

      if (event.type === "response.completed" && event.response.usage) {
        return [
          {
            type: "usage",
            source: "provider",
            inputTokens: normalizeTokenCount(event.response.usage.input_tokens),
            outputTokens: normalizeTokenCount(event.response.usage.output_tokens),
          },
        ]
      }

      return []
    },
  }
}

export function createOpenAICompatibleEventNormalizer() {
  const toolCalls = new Map<number, OpenAICompatibleToolCallState>()
  const thinkBlockParser = createThinkBlockParser()
  const reasoningDetailsParser = createReasoningDetailsParser()

  return {
    push(chunk: OpenAI.Chat.ChatCompletionChunk): ModelEvent[] {
      const events: ModelEvent[] = []

      for (const choice of chunk.choices) {
        const reasoningDetails = reasoningDetailsParser.push(choice.delta)
        if (reasoningDetails) {
          events.push({ type: "reasoning.delta", text: reasoningDetails })
        }

        const reasoningContent = readOpenAICompatibleReasoningContent(choice.delta)
        if (reasoningContent) {
          events.push({ type: "reasoning.delta", text: reasoningContent })
        }

        if (choice.delta.content) {
          events.push(...thinkBlockParser.push(choice.delta.content))
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

      if (chunk.usage) {
        events.push({
          type: "usage",
          source: "provider",
          inputTokens: normalizeTokenCount(chunk.usage.prompt_tokens),
          outputTokens: normalizeTokenCount(chunk.usage.completion_tokens),
        })
      }

      return events
    },
    flush() {
      return [
        ...thinkBlockParser.flush(),
        ...flushOpenAICompatibleToolCalls(toolCalls),
      ]
    },
  }
}

function createReasoningDetailsParser() {
  let bufferedText = ""

  return {
    push(delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta) {
      const text = readOpenAICompatibleReasoningDetails(delta)
      if (!text) {
        return null
      }

      if (text.startsWith(bufferedText)) {
        const nextText = text.slice(bufferedText.length)
        bufferedText = text
        return nextText.length > 0 ? nextText : null
      }

      if (bufferedText.startsWith(text)) {
        return null
      }

      bufferedText += text
      return text
    },
  }
}

function normalizeTokenCount(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0
  }

  return Math.trunc(value)
}

function createThinkBlockParser() {
  const closeTag = "</think>"
  let pending = ""
  let mode: "text" | "reasoning" = "text"

  return {
    push(text: string): ModelEvent[] {
      pending += text
      return drainPendingThinkBlocks({ final: false })
    },
    flush(): ModelEvent[] {
      return drainPendingThinkBlocks({ final: true })
    },
  }

  function drainPendingThinkBlocks(input: { final: boolean }): ModelEvent[] {
    const events: ModelEvent[] = []

    while (pending.length > 0) {
      if (mode === "text") {
        const openMatch = findOpenThinkTag(pending)
        if (openMatch) {
          const { index: openIndex, length: openLength } = openMatch
          pushTextEvent(events, pending.slice(0, openIndex))
          pending = pending.slice(openIndex + openLength)
          mode = "reasoning"
          continue
        }

        const keepLength = input.final ? 0 : partialOpenThinkTagSuffixLength(pending)
        pushTextEvent(events, pending.slice(0, pending.length - keepLength))
        pending = pending.slice(pending.length - keepLength)
        break
      }

      const closeIndex = indexOfTag(pending, closeTag)
      if (closeIndex >= 0) {
        pushReasoningEvent(events, pending.slice(0, closeIndex))
        pending = pending.slice(closeIndex + closeTag.length)
        mode = "text"
        continue
      }

      const keepLength = input.final ? 0 : partialTagSuffixLength(pending, closeTag)
      pushReasoningEvent(events, pending.slice(0, pending.length - keepLength))
      pending = pending.slice(pending.length - keepLength)
      break
    }

    return events
  }
}

function findOpenThinkTag(value: string) {
  const match = /<think\b[^>]*>/i.exec(value)
  if (!match || match.index == null) {
    return null
  }

  return {
    index: match.index,
    length: match[0].length,
  }
}

function partialOpenThinkTagSuffixLength(value: string) {
  for (let start = value.length - 1; start >= 0; start -= 1) {
    const suffix = value.slice(start)
    const normalized = suffix.toLowerCase()

    if ("<think".startsWith(normalized) || /^<think\b[^>]*$/i.test(suffix)) {
      return suffix.length
    }
  }

  return 0
}

function pushTextEvent(events: ModelEvent[], text: string) {
  if (text.length > 0) {
    events.push({ type: "text.delta", text })
  }
}

function pushReasoningEvent(events: ModelEvent[], text: string) {
  if (text.length > 0) {
    events.push({ type: "reasoning.delta", text })
  }
}

function indexOfTag(value: string, tag: string) {
  return value.toLowerCase().indexOf(tag)
}

function partialTagSuffixLength(value: string, tag: string) {
  const normalized = value.toLowerCase()

  for (let length = Math.min(tag.length - 1, normalized.length); length > 0; length -= 1) {
    if (tag.startsWith(normalized.slice(-length))) {
      return length
    }
  }

  return 0
}

function readOpenAICompatibleReasoningContent(
  delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta,
) {
  return typeof (delta as { reasoning_content?: unknown }).reasoning_content === "string"
    ? (delta as { reasoning_content: string }).reasoning_content
    : null
}

function readOpenAICompatibleReasoningDetails(
  delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta,
) {
  const reasoningDetails = (delta as { reasoning_details?: unknown }).reasoning_details

  if (typeof reasoningDetails === "string") {
    return reasoningDetails
  }

  if (!Array.isArray(reasoningDetails)) {
    return null
  }

  const text = reasoningDetails
    .map((detail) => {
      if (!detail || typeof detail !== "object") {
        return ""
      }

      const value = (detail as { text?: unknown }).text
      return typeof value === "string" ? value : ""
    })
    .join("")

  return text.length > 0 ? text : null
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
