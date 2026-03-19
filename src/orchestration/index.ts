import { createInMemoryActiveRunRegistry } from "./repo"
import type { CreateOrchestrationRuntimeApiInput } from "./runtime/api"

export type OrchestrationActiveRunRegistry = NonNullable<
  CreateOrchestrationRuntimeApiInput["activeRuns"]
>

export function createOrchestrationActiveRunRegistry(): OrchestrationActiveRunRegistry {
  return createInMemoryActiveRunRegistry()
}

export * from "./config/defaults"
export type {
  OrchestrationModelEvent,
  OrchestrationModelPort,
  OrchestrationModelTurnRequest,
} from "./ports/model"
export type {
  OrchestrationPermissionCoordinator,
  OrchestrationPermissionDecision,
  OrchestrationPermissionMode,
  OrchestrationPermissionPort,
  OrchestrationPermissionRequestRecord,
  OrchestrationPermissionResponse,
  OrchestrationPermissionStatus,
  OrchestrationPendingPermissionRequest,
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
export * from "./repo"
export {
  createOrchestrationRuntimeApi,
  PermissionRequestNotAwaitingActiveRuntimeError,
  type CreateOrchestrationRuntimeApiInput,
  type OrchestrationRuntimeApi,
  type OrchestrationRunInput,
} from "./runtime/api"
export * from "./types"
