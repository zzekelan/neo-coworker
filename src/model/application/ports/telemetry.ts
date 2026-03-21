export type ModelTelemetryPort = {
  recordModelEvent?(event: string, attributes?: Record<string, unknown>): void
}
