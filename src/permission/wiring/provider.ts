import type { PermissionTelemetryPort } from "../ports/telemetry"
import type { PermissionRuntimeApi } from "../runtime/api"

export type PermissionProvider = PermissionRuntimeApi

export function createPermissionProvider(input: {
  runtime: PermissionRuntimeApi
  telemetry?: PermissionTelemetryPort
}) {
  input.telemetry?.recordPermissionEvent?.("permission.provider.created")
  return input.runtime
}
