import {
  projectModelTurn,
  type ModelEvent,
  type ModelProjectionInput,
  type ModelTurnRequest,
} from "../service"

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
