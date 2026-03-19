import {
  createOrchestrationActiveRunRegistry,
  createOrchestrationStepService,
  resolveOrchestrationPermissionPolicy,
  type CreateOrchestrationRuntimeApiInput,
  type OrchestrationRunHandle,
  type OrchestrationRunInput,
  type RuntimeEvent,
} from "../service"
import { runOrchestrationLoop } from "./loop"
import {
  createRunSuspension,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "./suspend"
import { createEventQueue } from "./stream"

export { PermissionRequestNotAwaitingActiveRuntimeError }
export type {
  CreateOrchestrationRuntimeApiInput,
  OrchestrationRunHandle,
  OrchestrationRunInput,
  RuntimeEvent,
  RunHandle,
} from "../service"

const DEFAULT_SYSTEM_PROMPT = "You are the agent runtime."
const sharedActiveRuns = createOrchestrationActiveRunRegistry()

export function createOrchestrationRuntimeApi(input: CreateOrchestrationRuntimeApiInput) {
  const now = input.now ?? Date.now
  const activeRuns = input.activeRuns ?? sharedActiveRuns
  const stepService = createOrchestrationStepService({
    session: input.session,
    model: input.model,
    now,
  })

  function respondPermission(response: Parameters<OrchestrationRunHandle["respondPermission"]>[0]) {
    const permissionRequest = input.permission.getPermissionRequest(response.requestId)
    const activeRun = activeRuns.get({
      storageIdentity: input.session.storageIdentity,
      sessionId: permissionRequest.sessionId,
      runId: permissionRequest.runId,
    })

    if (!activeRun || !activeRun.suspend.isPending(response.requestId)) {
      if (permissionRequest.status !== "pending") {
        input.permission.respondPermission({
          requestId: response.requestId,
          decision: response.decision,
          resolvedAt: now(),
        })
      }

      throw new PermissionRequestNotAwaitingActiveRuntimeError({
        requestId: permissionRequest.id,
        runId: permissionRequest.runId,
        sessionId: permissionRequest.sessionId,
      })
    }

    activeRun.suspend.respond(response)
  }

  function cancelRun(runId: string) {
    const run = input.session.getRun(runId)
    const activeRun = activeRuns.get({
      storageIdentity: input.session.storageIdentity,
      sessionId: run.sessionId,
      runId,
    })
    const didCancel = stepService.cancelRun({
      runId,
      emit: activeRun?.emit,
    })

    if (!didCancel) {
      return
    }

    input.permission.cancelPendingRequestsByRun(runId, now())

    if (!activeRun) {
      return
    }

    activeRun.controller.abort()
    activeRun.suspend.cancel()
  }

  return {
    async run(runInput: OrchestrationRunInput): Promise<OrchestrationRunHandle> {
      const activeRunKey = {
        storageIdentity: input.session.storageIdentity,
        sessionId: runInput.sessionId,
        runId: runInput.runId,
      }

      if (activeRuns.has(activeRunKey)) {
        throw new Error(`Run ${runInput.runId} is already active`)
      }

      const session = input.session.getSession(runInput.sessionId)
      const controller = new AbortController()
      const queue = createEventQueue<RuntimeEvent>()
      const emit = (event: RuntimeEvent) => {
        queue.push(event)
      }
      const suspend = createRunSuspension({
        permission: input.permission,
        runId: runInput.runId,
        sessionId: session.id,
        policy: resolveOrchestrationPermissionPolicy(input.permissionPolicy),
        now,
        emit,
      })
      const activeRun = {
        ...activeRunKey,
        controller,
        suspend,
        emit,
      }
      activeRuns.add(activeRun)
      const tools = input.tools.create({
        requestPermission(request) {
          return suspend.requestPermission(request)
        },
      })

      void runOrchestrationLoop({
        sessionId: session.id,
        runId: runInput.runId,
        stepService,
        emit,
        signal: controller.signal,
        tools,
        workspaceRoot: session.workspaceRoot,
        systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      }).finally(() => {
        suspend.cancel()
        activeRuns.delete(activeRunKey)
        queue.close()
      })

      return {
        events: queue.stream(),
        cancel() {
          cancelRun(runInput.runId)
        },
        respondPermission(response) {
          respondPermission(response)
        },
      }
    },
    respondPermission,
    cancelRun,
  }
}

export type OrchestrationRuntimeApi = ReturnType<typeof createOrchestrationRuntimeApi>
