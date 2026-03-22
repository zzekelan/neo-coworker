import type { PermissionMode, PermissionPolicy } from "../domain"

export function resolvePermissionMode(policy: PermissionPolicy, toolName: string): PermissionMode {
  return policy[toolName] ?? "deny"
}
