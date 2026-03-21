import type OpenAI from "openai"
import { createModelProvider } from "../application/runtime-api"
import {
  createOpenAICompatibleProvider,
  createOpenAIProvider,
} from "../infrastructure/runner"

export * from "../application"
export {
  createFakeProvider,
  createOpenAICompatibleProvider,
  createOpenAIProvider,
} from "../infrastructure/runner"

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
