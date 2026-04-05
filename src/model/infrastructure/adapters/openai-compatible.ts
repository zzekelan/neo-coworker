import type OpenAI from "openai"
import type { ZodTypeAny } from "zod"
import {
  type ModelMessage,
  type ModelTool,
} from "../../domain"
import type { Provider } from "../../application/ports/provider"
import { createOpenAICompatibleEventNormalizer } from "../normalize"

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

function unsupportedSchema(schema: ZodTypeAny): never {
  throw new Error(
    `Unsupported Zod schema type for openai-compatible tools: ${schema._def.typeName as string}`,
  )
}

function readMessageText(message: ModelMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
}

function toChatCompletionMessages(messages: ModelMessage[]): OpenAICompatibleMessage[] {
  const serialized: OpenAICompatibleMessage[] = []

  for (const message of messages) {
    if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") {
          continue
        }

        serialized.push({
          role: "tool",
          tool_call_id: part.callId,
          content: part.output,
        })
      }
      continue
    }

    const content = readMessageText(message)
    if (message.role === "assistant") {
      const toolCalls = message.parts
        .filter((part): part is Extract<typeof part, { type: "tool_call" }> => part.type === "tool_call")
        .map((part) => ({
          id: part.callId,
          type: "function" as const,
          function: {
            name: part.toolName,
            arguments: part.inputText,
          },
        }))

      if (!content && toolCalls.length === 0) {
        continue
      }

      serialized.push({
        role: "assistant",
        content: content || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      })
      continue
    }

    if (!content) {
      continue
    }

    serialized.push({
      role: message.role,
      content,
    })
  }

  return serialized
}

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  const typeName = schema._def.typeName as string

  if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
    return unwrapSchema((schema as ZodTypeAny & { unwrap(): ZodTypeAny }).unwrap())
  }

  if (typeName === "ZodEffects") {
    return unwrapSchema(
      (schema as ZodTypeAny & { _def: { schema: ZodTypeAny } })._def.schema,
    )
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

function toChatCompletionTool(tool: ModelTool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ? toJsonSchema(tool.inputSchema) : undefined,
    },
  }
}

export function createOpenAICompatibleProvider(input: {
  model: string
  client: OpenAICompatibleClient
}): Provider {
  return {
    async *streamTurn(request) {
      const stream = await input.client.chat.completions.create(
        {
          model: input.model,
          messages: [
            { role: "system", content: request.system },
            ...toChatCompletionMessages(request.messages),
          ],
          stream: true,
          stream_options: {
            include_usage: true,
          },
          tools: (request.tools as OpenAICompatibleTools["0"][]).map(toChatCompletionTool),
        },
        { signal: request.signal },
      )
      const normalize = createOpenAICompatibleEventNormalizer()

      for await (const chunk of stream) {
        yield* normalize.push(chunk)
      }

      yield* normalize.flush()
    },
  }
}
