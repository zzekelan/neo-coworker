import type OpenAI from "openai"
import type { OrchestrationModelPort } from "../../orchestration/ports/model"
import { createOpenAICompatibleProvider } from "../runtime/openai-compatible"
import { createOpenAIProvider } from "../runtime/openai"
import type { ModelRuntimeApi } from "../runtime/api"

export type ModelProvider = OrchestrationModelPort

export function createModelProvider(input: { runtime: ModelRuntimeApi }): ModelProvider {
  return {
    streamTurn(request) {
      return input.runtime.streamTurn(
        input.runtime.projectTurn({
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
