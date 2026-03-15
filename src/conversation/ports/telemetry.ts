export type ConversationTelemetryPort = {
  recordConversationEvent?(event: string, attributes?: Record<string, unknown>): void
}
