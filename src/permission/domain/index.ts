export type {
  PendingPermissionRequest,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
} from "./decision"
export {
  assessCommandRisk,
  DANGEROUS_PATTERNS,
  RiskLevel,
  type RiskAssessment,
} from "./risk-analyzer"
export {
  PERMISSION_STATUSES,
  type PermissionStatus,
  type StoredPermissionRequest,
} from "./request"
export { type PermissionPolicy } from "./policy"

export const DEFAULT_PERMISSION_POLICY = {
  apply_patch: "ask",
  write: "ask",
  edit: "ask",
  shell: "ask",
} as const
