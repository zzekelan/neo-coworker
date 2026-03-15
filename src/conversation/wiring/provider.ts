import type { ConversationTelemetryPort } from "../ports/telemetry"
import type { ConversationRuntimeApi } from "../runtime/api"

export type ConversationProvider = ConversationRuntimeApi

export function createConversationProvider(input: {
  runtime: ConversationRuntimeApi
  telemetry?: ConversationTelemetryPort
}) {
  input.telemetry?.recordConversationEvent?.("conversation.provider.created")
  return input.runtime
}
