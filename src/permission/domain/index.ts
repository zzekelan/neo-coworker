export type {
  PendingPermissionRequest,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
} from "./decision"
export {
  PERMISSION_STATUSES,
  type PermissionStatus,
  type StoredPermissionRequest,
} from "./request"
export { type PermissionPolicy } from "./policy"

export const DEFAULT_PERMISSION_POLICY = {
  write: "ask",
  edit: "ask",
  shell: "ask",
} as const
