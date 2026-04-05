import { createHash } from "node:crypto"
import {
  buildModelPromptSections,
  projectModelTurn,
} from "./projection"
import { estimateModelTurnUsage } from "./token-usage"
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
    async *streamTurn(request) {
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

      const outputEvents: Array<Extract<ModelEvent, { type: "text.delta" | "tool.call" }>> = []
      let observedUsage = false

      try {
        for await (const event of input.runtime.streamTurn(projected)) {
          if (event.type === "usage") {
            observedUsage = true
            observeTurnUsage({
              observer: input.observer,
              request,
              usage: event,
            })
            yield event
            continue
          }

          if (event.type === "text.delta" || event.type === "tool.call") {
            outputEvents.push(event)
          }

          yield event
        }
      } catch (error) {
        if (!observedUsage && outputEvents.length > 0) {
          const estimatedUsage = estimateModelTurnUsage({
            request: projected,
            outputEvents,
          })
          observeTurnUsage({
            observer: input.observer,
            request,
            usage: estimatedUsage,
          })
          yield estimatedUsage
        }

        throw error
      }

      if (!observedUsage) {
        const estimatedUsage = estimateModelTurnUsage({
          request: projected,
          outputEvents,
        })
        observeTurnUsage({
          observer: input.observer,
          request,
          usage: estimatedUsage,
        })
        yield estimatedUsage
      }
    },
  }
}

function hashPromptSection(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function observeTurnUsage(input: {
  observer?: ModelObserverPort
  request: ModelProviderRequest
  usage: Extract<ModelEvent, { type: "usage" }>
}) {
  if (!input.request.sessionId || !input.request.runId) {
    return
  }

  try {
    input.observer?.recordModelEvent?.({
      type: "model.turn.usage",
      sessionId: input.request.sessionId,
      runId: input.request.runId,
      turnKey: input.request.turnKey ?? `${input.request.runId}:turn_unkeyed`,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      tokenUsageSource: input.usage.source,
    })
  } catch {
    // Observability must not alter the model request path.
  }
}
