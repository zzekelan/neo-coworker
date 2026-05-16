export type OrchestrationPermissionPolicyMode = "allow" | "deny" | "ask"
export type OrchestrationRunPermissionDecision = "allow" | "deny"
export type OrchestrationRunPermissionResponse = {
  requestId: string
  decision: OrchestrationRunPermissionDecision
}

export type OrchestrationPermissionPolicy = Record<
  "apply_patch" | "write" | "edit" | "shell" | "webfetch" | "websearch" | "codesearch" | "plan_exit",
  OrchestrationPermissionPolicyMode
>
export type OrchestrationPermissionPolicyInput = Partial<OrchestrationPermissionPolicy>
