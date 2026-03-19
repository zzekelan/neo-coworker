import { createPermissionRepository, type PermissionDatabase } from "../repo"
import type { PermissionSessionPort } from "../ports/session"
import type { PermissionTelemetryPort } from "../ports/telemetry"
import { createPermissionRuntimeApi } from "../runtime/api"
import type { PermissionRuntimeApi } from "../runtime/api"

export type PermissionProvider = PermissionRuntimeApi

export function createPermissionProvider(input: {
  runtime: PermissionRuntimeApi
  telemetry?: PermissionTelemetryPort
}) {
  input.telemetry?.recordPermissionEvent?.("permission.provider.created")
  return input.runtime
}

export function createPermissionStorage(input: {
  database: PermissionDatabase
  now?: () => number
}) {
  return {
    repository: createPermissionRepository({
      database: input.database,
      now: input.now,
    }),
  }
}

export function createPermissionRuntimeProvider(input: {
  database: PermissionDatabase
  session: PermissionSessionPort
  now?: () => number
}) {
  const repository = createPermissionRepository({
    database: input.database,
    now: input.now,
  })
  const runtime = createPermissionRuntimeApi({
    repository,
    session: input.session,
    now: input.now,
  })

  return {
    repository,
    runtime: createPermissionProvider({
      runtime,
    }),
  }
}
