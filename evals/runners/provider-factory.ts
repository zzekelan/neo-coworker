import {
  createDefaultProvider,
  resolveDefaultProviderConfig,
  type DefaultProviderInput,
} from "../../src/bootstrap"
import type { EvalProviderFactory } from "../runner"
import type { EvalProviderInfo } from "../schemas/artifact"
import type { EvalTask } from "../schemas/task"
import { createScriptedEvalProviderFactory } from "./scripted-provider"

export function resolveEvalTaskProvider(input: {
  task: EvalTask
} & Pick<
  DefaultProviderInput,
  "env" | "createClient" | "createOpenAIProviderImpl" | "createOpenAICompatibleProviderImpl"
>): {
  createProvider: EvalProviderFactory
  providerInfo: EvalProviderInfo
} {
  if (input.task.providerMode === "scripted") {
    if (!input.task.scenario) {
      throw new Error(`Scripted eval task ${input.task.id} is missing a scenario`)
    }

    return {
      createProvider: createScriptedEvalProviderFactory(input.task.scenario),
      providerInfo: {
        mode: "scripted",
        kind: "scripted",
        model: null,
      },
    }
  }

  const config = resolveDefaultProviderConfig(input.env)

  return {
    createProvider: ({ modelObserver }) =>
      createDefaultProvider({
        env: input.env,
        modelObserver,
        createClient: input.createClient,
        createOpenAIProviderImpl: input.createOpenAIProviderImpl,
        createOpenAICompatibleProviderImpl: input.createOpenAICompatibleProviderImpl,
      }),
    providerInfo: {
      mode: "live",
      kind: config.provider,
      model: config.model,
    },
  }
}
