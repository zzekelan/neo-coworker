import type { RuntimeEvent } from "./event"
import type { OrchestrationModelPort } from "./ports/model"
import type {
  OrchestrationPermissionPort,
  OrchestrationPermissionResponse,
} from "./ports/permission"
import type { OrchestrationSessionPort } from "./ports/session"
import type {
  OrchestrationToolPort,
  OrchestrationToolPortFactory,
} from "./ports/tool"
import type { OrchestrationPermissionPolicy } from "./permission"
import { createOrchestrationStepService } from "./step-service"

export type {
  OrchestrationModelEvent,
  OrchestrationModelPort,
  OrchestrationModelTurnRequest,
} from "./ports/model"
export type {
  OrchestrationPendingPermissionRequest,
  OrchestrationPermissionCoordinator,
  OrchestrationPermissionDecision,
  OrchestrationPermissionMode,
  OrchestrationPermissionPort,
  OrchestrationPermissionRequestRecord,
  OrchestrationPermissionResponse,
  OrchestrationPermissionStatus,
} from "./ports/permission"
export type {
  OrchestrationMessageRecord,
  OrchestrationPartRecord,
  OrchestrationRunRecord,
  OrchestrationRunStatus,
  OrchestrationSessionPort,
  OrchestrationSessionRecord,
  OrchestrationTranscriptMessage,
  OrchestrationTranscriptPart,
} from "./ports/session"
export type {
  OrchestrationTool,
  OrchestrationToolExecutionInput,
  OrchestrationToolExecutionResult,
  OrchestrationToolPort,
  OrchestrationToolPortFactory,
  RequestOrchestrationToolPermission,
} from "./ports/tool"
export type { OrchestrationRunHandle, RunHandle } from "./handle"
export type {
  OrchestrationPermissionPolicy,
  OrchestrationPermissionPolicyInput,
  OrchestrationPermissionPolicyMode,
  OrchestrationRunPermissionDecision,
  OrchestrationRunPermissionResponse,
} from "./permission"
export { OrchestrationRunSchema, RunSchema } from "./run"
export type { OrchestrationRun, Run } from "./run"
export type { OrchestrationRuntimeEvent, RuntimeEvent } from "./event"

export type OrchestrationEventEmitter = (event: RuntimeEvent) => void

export type OrchestrationRunSuspension = {
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

export type OrchestrationResolvedPermissionPolicy = OrchestrationPermissionPolicy

export type OrchestrationActiveRunKey = {
  storageIdentity: string
  sessionId: string
  runId: string
}

export type OrchestrationActiveRunRecord = OrchestrationActiveRunKey & {
  controller: AbortController
  suspend: OrchestrationRunSuspension
  emit: OrchestrationEventEmitter
}

export type OrchestrationActiveRunRegistry = {
  has(input: OrchestrationActiveRunKey): boolean
  get(input: OrchestrationActiveRunKey): OrchestrationActiveRunRecord | undefined
  add(activeRun: OrchestrationActiveRunRecord): void
  delete(input: OrchestrationActiveRunKey): void
}

export type CreateOrchestrationRuntimeApiInput = {
  model: OrchestrationModelPort
  session: OrchestrationSessionPort
  permission: OrchestrationPermissionPort
  tools: OrchestrationToolPortFactory
  activeRuns: OrchestrationActiveRunRegistry
  permissionPolicy: OrchestrationPermissionPolicy
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

export { createOrchestrationStepService } from "./step-service"
