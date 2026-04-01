import type {
  OrchestrationPermissionPolicy,
  OrchestrationPermissionPolicyInput,
} from "./permission"

export const DEFAULT_ORCHESTRATION_PERMISSION_POLICY: OrchestrationPermissionPolicy = {
  write: "ask",
  edit: "ask",
  shell: "ask",
  webfetch: "ask",
  websearch: "allow",
  codesearch: "ask",
}

export type ResolvedPermissionPolicy = OrchestrationPermissionPolicy
export type PermissionPolicyInput = OrchestrationPermissionPolicyInput

export function resolvePermissionPolicy(
  input?: PermissionPolicyInput,
): ResolvedPermissionPolicy {
  return {
    ...DEFAULT_ORCHESTRATION_PERMISSION_POLICY,
    ...input,
  }
}
