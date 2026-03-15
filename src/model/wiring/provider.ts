import type { OrchestrationModelPort } from "../../orchestration/ports/model"
import { projectModelTurn } from "../service/projection"
import type { ModelRuntimeApi } from "../runtime/api"

export type ModelProvider = OrchestrationModelPort

export function createModelProvider(input: { runtime: ModelRuntimeApi }): ModelProvider {
  return {
    streamTurn(request) {
      return input.runtime.streamTurn(
        projectModelTurn({
          systemPrompt: request.systemPrompt,
          activeSkillInstructions: request.activeSkillInstructions,
          tools: request.tools,
          transcript: request.transcript,
          signal: request.signal,
        }),
      )
    },
  }
}
