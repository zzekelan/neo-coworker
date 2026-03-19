import type { PermissionSessionPort } from "./ports/session"
import type { PermissionTelemetryPort } from "./ports/telemetry"
import { createPermissionRepository, type PermissionDatabase } from "./repo"
import {
  createPermissionRuntimeApi,
  type PermissionRuntimeApi,
} from "./runtime/api"

export * from "./config/defaults"
export type { PermissionSessionPort } from "./ports/session"
export type { PermissionTelemetryPort } from "./ports/telemetry"
export {
  PermissionNotFoundError,
  PermissionRepositoryError,
  createPermissionRepository,
  type CreatePermissionRequestInput,
  type PermissionDatabase,
  type PermissionRepository,
  type UpdatePermissionRequestStatusInput,
} from "./repo"
export * from "./service"
export {
  createPermissionRuntimeApi,
  type CreatePermissionRuntimeApiInput,
  type PermissionRuntimeApi,
} from "./runtime/api"

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
