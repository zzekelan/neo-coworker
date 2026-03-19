import type { OrchestrationPermissionPolicy } from "../types/permission"

export const DEFAULT_ORCHESTRATION_PERMISSION_POLICY: OrchestrationPermissionPolicy = {
  write: "ask",
  edit: "ask",
  shell: "ask",
}
