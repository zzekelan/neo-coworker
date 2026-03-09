import type OpenAI from "openai"
import type { ZodTypeAny } from "zod"
import type { Provider, ProviderEvent, ProviderTurnRequest } from "./types"

type OpenAICompatibleChunk = OpenAI.Chat.ChatCompletionChunk
type OpenAICompatibleMessage = OpenAI.Chat.ChatCompletionMessageParam
type OpenAICompatibleRequest = OpenAI.Chat.ChatCompletionCreateParamsStreaming
type OpenAICompatibleTools = OpenAI.Chat.ChatCompletionTool[]

type OpenAICompatibleClient = {
  chat: {
    completions: {
      create(
        body: OpenAICompatibleRequest,
        options?: OpenAI.RequestOptions,
      ): AsyncIterable<OpenAICompatibleChunk> | Promise<AsyncIterable<OpenAICompatibleChunk>>
    }
  }
}

type RuntimeMessage = {
  role: string
  parts?: Array<{
    type: string
    text?: string
  }>
  content?: string
}

type RuntimeTool = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
}

type ToolCallState = {
  callId?: string
  name?: string
  inputText: string
  emitted: boolean
}

function unsupportedSchema(schema: ZodTypeAny): never {
  throw new Error(
    `Unsupported Zod schema type for openai-compatible tools: ${schema._def.typeName as string}`,
  )
}

function readMessageText(message: RuntimeMessage) {
  if (typeof message.content === "string") {
    return message.content
  }

  const text = (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")

  return text
}

function toChatCompletionMessage(message: RuntimeMessage): OpenAICompatibleMessage {
  return {
    role: message.role as OpenAICompatibleMessage["role"],
    content: readMessageText(message),
  }
}

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  const typeName = schema._def.typeName as string

  if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
    return unwrapSchema((schema as ZodTypeAny & { unwrap(): ZodTypeAny }).unwrap())
  }

  return schema
}

function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const unwrapped = unwrapSchema(schema)
  const typeName = unwrapped._def.typeName as string

  switch (typeName) {
    case "ZodString":
      return { type: "string" }
    case "ZodNumber":
      return { type: "number" }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodLiteral":
      return {
        type: typeof (unwrapped as ZodTypeAny & { _def: { value: unknown } })._def.value,
        enum: [(unwrapped as ZodTypeAny & { _def: { value: unknown } })._def.value],
      }
    case "ZodEnum":
      return {
        type: "string",
        enum: (unwrapped as ZodTypeAny & { _def: { values: string[] } })._def.values,
      }
    case "ZodArray":
      return {
        type: "array",
        items: toJsonSchema(
          (unwrapped as ZodTypeAny & { _def: { type: ZodTypeAny } })._def.type,
        ),
      }
    case "ZodObject": {
      const objectSchema = unwrapped as ZodTypeAny & {
        shape: Record<string, ZodTypeAny>
      }
      const properties = Object.fromEntries(
        Object.entries(objectSchema.shape).map(([key, value]) => [key, toJsonSchema(value)]),
      )
      const required = Object.entries(objectSchema.shape)
        .filter(([, value]) => !value.isOptional())
        .map(([key]) => key)

      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      }
    }
    default:
      return unsupportedSchema(unwrapped)
  }
}

function toChatCompletionTool(tool: RuntimeTool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ? toJsonSchema(tool.inputSchema) : undefined,
    },
  }
}

function flushToolCalls(
  toolCalls: Map<number, ToolCallState>,
): ProviderEvent[] {
  const events: ProviderEvent[] = []

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

export function createOpenAICompatibleProvider(input: {
  model: string
  client: OpenAICompatibleClient
}): Provider {
  return {
    async *streamTurn(
      request: ProviderTurnRequest,
    ): AsyncGenerator<ProviderEvent, void, void> {
      const stream = await input.client.chat.completions.create(
        {
          model: input.model,
          messages: [
            { role: "system", content: request.system },
            ...(request.messages as RuntimeMessage[]).map(toChatCompletionMessage),
          ],
          stream: true,
          tools: (request.tools as RuntimeTool[]).map(toChatCompletionTool),
        },
        { signal: request.signal },
      )
      const toolCalls = new Map<number, ToolCallState>()

      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          if (choice.delta.content) {
            yield { type: "text.delta", text: choice.delta.content }
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
            yield* flushToolCalls(toolCalls)
          }
        }
      }

      yield* flushToolCalls(toolCalls)
    },
  }
}
