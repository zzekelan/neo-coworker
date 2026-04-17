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

function unsupportedRecordKeySchema(schema: ZodTypeAny): never {
  throw new Error(
    `Unsupported ZodRecord key schema for openai-compatible tools: ${schema._def.typeName as string}`,
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
          content: serializeToolResult(part),
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

function serializeToolResult(part: Extract<ModelMessage["parts"][number], { type: "tool_result" }>) {
  return part.isError ? `[error] ${part.output}` : part.output
}

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  const typeName = schema._def.typeName as string

  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    return unwrapSchema((schema as ZodTypeAny & { unwrap(): ZodTypeAny }).unwrap())
  }

  if (typeName === "ZodDefault") {
    return unwrapSchema(
      (schema as ZodTypeAny & { _def: { innerType: ZodTypeAny } })._def.innerType,
    )
  }

  if (typeName === "ZodEffects") {
    return unwrapSchema(
      (schema as ZodTypeAny & { _def: { schema: ZodTypeAny } })._def.schema,
    )
  }

  return schema
}

function readSchemaDescription(schema: ZodTypeAny): string | undefined {
  const directDescription = (schema._def as { description?: unknown }).description

  if (typeof directDescription === "string" && directDescription.length > 0) {
    return directDescription
  }

  const unwrapped = unwrapSchema(schema)
  const unwrappedDescription = (unwrapped._def as { description?: unknown }).description

  if (typeof unwrappedDescription === "string" && unwrappedDescription.length > 0) {
    return unwrappedDescription
  }

  return undefined
}

function withDescription(
  schema: Record<string, unknown>,
  zodSchema: ZodTypeAny,
): Record<string, unknown> {
  const description = readSchemaDescription(zodSchema)

  return description ? { ...schema, description } : schema
}

function toRecordAdditionalProperties(schema: ZodTypeAny): boolean | Record<string, unknown> {
  const unwrapped = unwrapSchema(schema)

  if ((unwrapped._def.typeName as string) === "ZodUnknown") {
    return true
  }

  return toJsonSchema(schema)
}

export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const unwrapped = unwrapSchema(schema)
  const typeName = unwrapped._def.typeName as string

  switch (typeName) {
    case "ZodString":
      return withDescription({ type: "string" }, schema)
    case "ZodNumber":
      return withDescription({ type: "number" }, schema)
    case "ZodBoolean":
      return withDescription({ type: "boolean" }, schema)
    case "ZodLiteral":
      return withDescription({
        type: typeof (unwrapped as ZodTypeAny & { _def: { value: unknown } })._def.value,
        enum: [(unwrapped as ZodTypeAny & { _def: { value: unknown } })._def.value],
      }, schema)
    case "ZodEnum":
      return withDescription({
        type: "string",
        enum: (unwrapped as ZodTypeAny & { _def: { values: string[] } })._def.values,
      }, schema)
    case "ZodArray":
      return withDescription({
        type: "array",
        items: toJsonSchema(
          (unwrapped as ZodTypeAny & { _def: { type: ZodTypeAny } })._def.type,
        ),
      }, schema)
    case "ZodRecord": {
      const recordSchema = unwrapped as ZodTypeAny & {
        _def: {
          keyType: ZodTypeAny
          valueType: ZodTypeAny
        }
      }
      const keySchema = unwrapSchema(recordSchema._def.keyType)

      if ((keySchema._def.typeName as string) !== "ZodString") {
        return unsupportedRecordKeySchema(keySchema)
      }

      return withDescription({
        type: "object",
        additionalProperties: toRecordAdditionalProperties(recordSchema._def.valueType),
      }, schema)
    }
    case "ZodObject": {
      const objectSchema = unwrapped as ZodTypeAny & {
        shape: Record<string, ZodTypeAny>
      }
      const properties = Object.fromEntries(
        Object.entries(objectSchema.shape).map(([key, value]) => [key, withDescription(toJsonSchema(value), value)]),
      )
      const required = Object.entries(objectSchema.shape)
        .filter(([, value]) => !value.isOptional())
        .map(([key]) => key)

      return withDescription({
        type: "object",
        properties,
        required,
        additionalProperties: false,
      }, schema)
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
          max_completion_tokens: 16000,
          parallel_tool_calls: true,
          tools: request.tools.map(toChatCompletionTool) as OpenAICompatibleTools,
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
