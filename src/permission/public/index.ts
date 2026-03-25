import {
  type PermissionSessionPort,
} from "../application"
import {
  createPermissionRepository,
  type PermissionDatabase,
} from "../infrastructure/sqlite"
import {
  createPermissionCoordinator,
  createPermissionProvider,
  createPermissionRuntimeApi,
  type CreatePermissionRuntimeApiInput,
  type PermissionCoordinator,
  type PermissionCoordinatorOptions,
  type PermissionProvider,
  type PermissionRuntimeApi,
} from "../infrastructure/runtime"

export * from "../application"
export {
  createPermissionRepository,
  type PermissionDatabase,
} from "../infrastructure/sqlite"
export {
  createPermissionCoordinator,
  createPermissionProvider,
  createPermissionRuntimeApi,
  type CreatePermissionRuntimeApiInput,
  type PermissionCoordinator,
  type PermissionCoordinatorOptions,
  type PermissionProvider,
  type PermissionRuntimeApi,
} from "../infrastructure/runtime"

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
  observer?: import("../application").PermissionObserverPort
}) {
  const repository = createPermissionRepository({
    database: input.database,
    now: input.now,
  })
  const runtime = createPermissionRuntimeApi({
    repository,
    session: input.session,
    now: input.now,
    observer: input.observer,
  })

  return {
    repository,
    runtime: createPermissionProvider({
      runtime,
    }),
  }
}
