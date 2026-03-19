import type OpenAI from "openai"
import type { ModelTelemetryPort } from "./ports/telemetry"
import {
  createOpenAICompatibleProvider,
  createOpenAIProvider,
} from "./runtime/runner"
import type { ModelRuntimeApi } from "./runtime/api"
import type { ModelEvent, ModelProjectionInput, ModelTurnRequest } from "./service"

export * from "./config/defaults"
export type { ModelTelemetryPort } from "./ports/telemetry"
export * from "./service"
export {
  createModelRuntimeApi,
  type CreateModelRuntimeApiInput,
  type ModelRuntimeApi,
  type Provider,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "./runtime/api"
export {
  createFakeProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
} from "./runtime/runner"

export type ModelProviderRequest = ModelProjectionInput &
  Pick<ModelTurnRequest, "signal">

export type ModelProvider = {
  streamTurn(request: ModelProviderRequest): AsyncIterable<ModelEvent>
}

export function createModelProvider(input: {
  runtime: ModelRuntimeApi
  telemetry?: ModelTelemetryPort
}): ModelProvider {
  return {
    streamTurn(request) {
      input.telemetry?.recordModelEvent?.("model.turn.requested")
      const projected = input.runtime.projectTurn({
        systemPrompt: request.systemPrompt,
        activeSkillInstructions: request.activeSkillInstructions,
        tools: request.tools,
        transcript: request.transcript,
        signal: request.signal,
      })

      return input.runtime.streamTurn(projected)
    },
  }
}

export function createOpenAIModelProvider(input: {
  model: string
  client: OpenAI
}) {
  return createModelProvider({
    runtime: createOpenAIProvider(input),
  })
}

export function createOpenAICompatibleModelProvider(input: {
  model: string
  client: OpenAI
}) {
  return createModelProvider({
    runtime: createOpenAICompatibleProvider(input),
  })
}
