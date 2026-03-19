import { DEFAULT_ORCHESTRATION_PERMISSION_POLICY } from "../config/defaults"

export type ResolvedPermissionPolicy = typeof DEFAULT_ORCHESTRATION_PERMISSION_POLICY
export type PermissionPolicyInput = Partial<ResolvedPermissionPolicy>

export function resolvePermissionPolicy(input?: PermissionPolicyInput): ResolvedPermissionPolicy {
  return {
    ...DEFAULT_ORCHESTRATION_PERMISSION_POLICY,
    ...input,
  }
}
