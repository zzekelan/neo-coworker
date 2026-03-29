import { createHash } from "node:crypto"
import {
  buildModelPromptSections,
  projectModelTurn,
} from "./projection"
import type { ModelObserverPort } from "./ports/model-observer"
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
  Pick<ProviderTurnRequest, "signal"> & {
    sessionId?: string
    runId?: string
  }

export type ModelProvider = {
  streamTurn(request: ModelProviderRequest): AsyncIterable<ModelEvent>
}

export function createModelProvider(input: {
  runtime: ModelRuntimeApi
  observer?: ModelObserverPort
}): ModelProvider {
  return {
    streamTurn(request) {
      if (request.sessionId && request.runId) {
        try {
          input.observer?.recordModelEvent?.({
            type: "model.turn.requested",
            sessionId: request.sessionId,
            runId: request.runId,
            turnKey: request.turnKey,
          })
          const sections = buildModelPromptSections({
            systemPrompt: request.systemPrompt,
            skillCatalog: request.skillCatalog,
            activeSkills: request.activeSkills,
            tools: request.tools,
          })
          input.observer?.recordModelEvent?.({
            type: "model.prompt.assembled",
            sessionId: request.sessionId,
            runId: request.runId,
            turnKey: request.turnKey ?? `${request.runId}:turn_unkeyed`,
            catalogSkillNames: request.skillCatalog.map((skill) => skill.name),
            activeSkillNames: request.activeSkills.map((skill) => skill.name),
            activeSkillCount: request.activeSkills.length,
            activeSkillSectionHash: hashPromptSection(sections.activeSkillSection),
            activeSkillSectionLength: sections.activeSkillSection.length,
          })
        } catch {
          // Observability must not alter the model request path.
        }
      }
      const projected = input.runtime.projectTurn({
        systemPrompt: request.systemPrompt,
        skillCatalog: request.skillCatalog,
        activeSkills: request.activeSkills,
        tools: request.tools,
        transcript: request.transcript,
        signal: request.signal,
      })

      return input.runtime.streamTurn(projected)
    },
  }
}

function hashPromptSection(text: string) {
  return createHash("sha256").update(text).digest("hex")
}
