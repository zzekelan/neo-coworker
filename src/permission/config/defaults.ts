export {
  type PendingPermissionRequest,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
} from "../types/decision"
export { PERMISSION_STATUSES, type PermissionStatus, type StoredPermissionRequest } from "../types/request"
export { type PermissionPolicy } from "../types/policy"

export const DEFAULT_PERMISSION_POLICY = {
  write: "ask",
  edit: "ask",
  shell: "ask",
} as const
