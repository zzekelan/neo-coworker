export type SessionTelemetryPort = {
  recordSessionEvent?(event: string, attributes?: Record<string, unknown>): void
}
