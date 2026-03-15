import type { PermissionMode, PermissionPolicy } from "../repo"

export function resolvePermissionMode(policy: PermissionPolicy, toolName: string): PermissionMode {
  return policy[toolName] ?? "deny"
}
