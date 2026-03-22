export type OrchestrationPermissionPolicyMode = "allow" | "deny" | "ask"
export type OrchestrationRunPermissionDecision = "allow" | "deny"
export type OrchestrationRunPermissionResponse = {
  requestId: string
  decision: OrchestrationRunPermissionDecision
}

export type OrchestrationPermissionPolicy = Record<
  "write" | "edit" | "shell",
  OrchestrationPermissionPolicyMode
>
export type OrchestrationPermissionPolicyInput = Partial<OrchestrationPermissionPolicy>
