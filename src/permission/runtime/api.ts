import {
  createPermissionQueryService,
  createPermissionRequestService,
  createPermissionRespondService,
  type CreatePermissionQueryServiceInput,
  type CreatePermissionRequestServiceInput,
  type CreatePermissionRespondServiceInput,
  type PermissionMode,
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
