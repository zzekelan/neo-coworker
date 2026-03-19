import type OpenAI from "openai"
import {
  projectModelTurn,
  type ModelEvent,
  type ModelProjectionInput,
  type ModelTelemetryPort,
  type ModelTurnRequest,
} from "../service"
import {
  createOpenAICompatibleProvider,
  createOpenAIProvider,
} from "./runner"

export type CreateModelRuntimeApiInput = {
  streamTurn(request: ModelTurnRequest): AsyncIterable<ModelEvent>
}

export function createModelRuntimeApi(input: CreateModelRuntimeApiInput) {
  return {
    projectTurn(request: ModelProjectionInput & Pick<ModelTurnRequest, "signal">) {
      return projectModelTurn(request)
    },
    streamTurn(request: ModelTurnRequest) {
      return input.streamTurn(request)
    },
  }
}

export type ModelRuntimeApi = ReturnType<typeof createModelRuntimeApi>

export type Provider = ModelRuntimeApi
export type ProviderEvent = ModelEvent
export type ProviderTurnRequest = ModelTurnRequest

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

export * from "../service"
export {
  createFakeProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
} from "./runner"
