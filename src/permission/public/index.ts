import {
  createPermissionProvider,
  createPermissionRuntimeApi,
  type PermissionSessionPort,
} from "../application"
import {
  createPermissionRepository,
  type PermissionDatabase,
} from "../infrastructure/sqlite"

export * from "../application"
export {
  createPermissionRepository,
  type PermissionDatabase,
} from "../infrastructure/sqlite"

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
