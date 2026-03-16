import {
  createConversationRepository,
  openConversationDatabase,
  type ConversationDatabase,
} from "../repo"
import type { ConversationTelemetryPort } from "../ports/telemetry"
import { createConversationRuntimeApi } from "../runtime/api"
import type { ConversationRuntimeApi } from "../runtime/api"

export type ConversationProvider = ConversationRuntimeApi

export function createConversationProvider(input: {
  runtime: ConversationRuntimeApi
  telemetry?: ConversationTelemetryPort
}) {
  input.telemetry?.recordConversationEvent?.("conversation.provider.created")
  return input.runtime
}

export function openConversationStorage(path: string) {
  return openConversationDatabase(path)
}

export function createConversationStorage(input: {
  database: ConversationDatabase
  now?: () => number
}) {
  const repository = createConversationRepository({
    database: input.database,
    now: input.now,
  })
  const runtime = createConversationRuntimeApi({
    repository,
    now: input.now,
  })

  return {
    repository,
    runtime: createConversationProvider({
      runtime,
    }),
  }
}
