import type { OrchestrationSessionPort } from "../ports/session"
import type { OrchestrationModelPort } from "../ports/model"
import type { OrchestrationPermissionPort, OrchestrationPermissionResponse } from "../ports/permission"
import type { OrchestrationToolPort, OrchestrationToolPortFactory } from "../ports/tool"
import type {
  OrchestrationRunHandle as PublicOrchestrationRunHandle,
  RuntimeEvent as PublicRuntimeEvent,
} from "../index"
import {
  createInMemoryActiveRunRegistry,
  resolvePermissionPolicy,
  type ActiveRunRecord,
  type ActiveRunRegistry,
  type PermissionPolicyInput,
  type ResolvedPermissionPolicy,
} from "../repo"
import { createOrchestrationStepService } from "./step"

export type RuntimeEvent = PublicRuntimeEvent
export type OrchestrationRunHandle = PublicOrchestrationRunHandle
export type RunHandle = OrchestrationRunHandle

export type OrchestrationEventEmitter = (event: RuntimeEvent) => void
export type OrchestrationResolvedPermissionPolicy = ResolvedPermissionPolicy

export type OrchestrationRunSuspension = {
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

export type OrchestrationActiveRunState = ActiveRunRecord<
  OrchestrationRunSuspension,
  OrchestrationEventEmitter
>
export type OrchestrationActiveRunRegistry = ActiveRunRegistry<
  OrchestrationRunSuspension,
  OrchestrationEventEmitter
>

export type CreateOrchestrationRuntimeApiInput = {
  model: OrchestrationModelPort
  session: OrchestrationSessionPort
  permission: OrchestrationPermissionPort
  tools: OrchestrationToolPortFactory
  activeRuns?: OrchestrationActiveRunRegistry
  permissionPolicy?: PermissionPolicyInput
  systemPrompt?: string
  now?: () => number
}

export type OrchestrationRunInput = {
  sessionId: string
  runId: string
}

export type OrchestrationLoopInput = {
  sessionId: string
  runId: string
  signal: AbortSignal
  emit: OrchestrationEventEmitter
  tools: OrchestrationToolPort
  workspaceRoot: string
  systemPrompt: string
  stepService: ReturnType<typeof createOrchestrationStepService>
}

export function createOrchestrationActiveRunRegistry(): OrchestrationActiveRunRegistry {
  return createInMemoryActiveRunRegistry()
}

export function resolveOrchestrationPermissionPolicy(
  input?: PermissionPolicyInput,
): OrchestrationResolvedPermissionPolicy {
  return resolvePermissionPolicy(input)
}

export { createOrchestrationStepService } from "./step"
