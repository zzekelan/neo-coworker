import {
  projectModelTurn,
} from "./projection"
import type { ModelTelemetryPort } from "./ports/telemetry"
import type {
  ModelEvent,
  ModelProjectionInput,
} from "../domain"
import type {
  Provider,
  ProviderTurnRequest,
} from "./ports/provider"

export type CreateModelRuntimeApiInput = Provider

export function createModelRuntimeApi(input: CreateModelRuntimeApiInput) {
  return {
    projectTurn(request: ModelProjectionInput & Pick<ProviderTurnRequest, "signal">) {
      return projectModelTurn(request)
    },
    streamTurn(request: ProviderTurnRequest) {
      return input.streamTurn(request)
    },
  }
}

export type ModelRuntimeApi = ReturnType<typeof createModelRuntimeApi>

export type ModelProviderRequest = ModelProjectionInput &
  Pick<ProviderTurnRequest, "signal">

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
