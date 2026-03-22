import type OpenAI from "openai"
import { createModelProvider, createModelRuntimeApi } from "../application/runtime-api"
import {
  createFakeAdapter,
  createOpenAIAdapter,
  createOpenAICompatibleAdapter,
} from "../infrastructure/runner"

export * from "../application"
export {
  createFakeAdapter,
  createOpenAIAdapter,
  createOpenAICompatibleAdapter,
} from "../infrastructure/runner"

export function createFakeProvider(
  input: Parameters<typeof createFakeAdapter>[0] = {},
) {
  return createModelRuntimeApi(createFakeAdapter(input))
}

export function createOpenAIProvider(input: {
  model: string
  client: OpenAI
}) {
  return createModelRuntimeApi(createOpenAIAdapter(input))
}

export function createOpenAICompatibleProvider(input: {
  model: string
  client: OpenAI
}) {
  return createModelRuntimeApi(createOpenAICompatibleAdapter(input))
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
