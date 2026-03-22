export type PermissionTelemetryPort = {
  recordPermissionEvent?(event: string, attributes?: Record<string, unknown>): void
}
