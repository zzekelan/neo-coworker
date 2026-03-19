import {
  createPermissionRepository,
  createPermissionQueryService,
  createPermissionRequestService,
  createPermissionRespondService,
  type CreatePermissionQueryServiceInput,
  type CreatePermissionRequestServiceInput,
  type CreatePermissionRespondServiceInput,
  type PermissionDatabase,
  type PermissionMode,
  type PermissionSessionPort,
  type PermissionTelemetryPort,
} from "../service"
import { createPermissionCoordinator, type PermissionCoordinatorOptions } from "./coordinator"

export type CreatePermissionRuntimeApiInput = CreatePermissionRequestServiceInput &
  CreatePermissionRespondServiceInput &
  CreatePermissionQueryServiceInput

export function createPermissionRuntimeApi(input: CreatePermissionRuntimeApiInput) {
  const query = createPermissionQueryService(input)
  const request = createPermissionRequestService(input)
  const respond = createPermissionRespondService(input)

  return {
    createCoordinator(
      policy: Record<string, PermissionMode>,
      options: PermissionCoordinatorOptions = {},
    ) {
      return createPermissionCoordinator(policy, options)
    },
    getPermissionRequest: query.getPermissionRequest,
    listPermissionRequestsByRun: query.listPermissionRequestsByRun,
    cancelPendingRequestsByRun: query.cancelPendingRequestsByRun,
    requestPermission: request.requestPermission,
    respondPermission: respond.respondPermission,
  }
}

export type PermissionRuntimeApi = ReturnType<typeof createPermissionRuntimeApi>

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

export * from "../service"
