export type ToolTelemetryPort = {
  recordToolEvent?(event: string, attributes?: Record<string, unknown>): void
}
