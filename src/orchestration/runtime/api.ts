import {
  createOrchestrationStepService,
  type CreateOrchestrationRuntimeApiInput,
  type OrchestrationRunHandle,
  type OrchestrationRunInput,
  type RuntimeEvent,
  OrchestrationRunSchema,
  type RunHandle,
  RunSchema,
} from "../service"
import { runOrchestrationLoop } from "./loop"
import { createActiveRunRegistry } from "./registry"
import {
  createRunSuspension,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "./suspend"
import { createEventQueue } from "./stream"

const sharedActiveRuns = createActiveRunRegistry()

export { PermissionRequestNotAwaitingActiveRuntimeError, OrchestrationRunSchema, RunSchema }
export type {
  OrchestrationRun,
  OrchestrationRuntimeEvent,
  RuntimeEvent,
  OrchestrationRunHandle,
  RunHandle,
} from "../service"

export function createOrchestrationRuntimeApi(
  input: CreateOrchestrationRuntimeApiInput,
) {
  const now = input.now ?? Date.now
  const stepService = createOrchestrationStepService({
    conversation: input.conversation,
    model: input.model,
    now,
  })

  function respondPermission(response: Parameters<OrchestrationRunHandle["respondPermission"]>[0]) {
    const permissionRequest = input.permission.getPermissionRequest(response.requestId)
    const activeRun = sharedActiveRuns.get({
      storageIdentity: input.conversation.storageIdentity,
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
    const run = input.conversation.getRun(runId)
    const activeRun = sharedActiveRuns.get({
      storageIdentity: input.conversation.storageIdentity,
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
        storageIdentity: input.conversation.storageIdentity,
        sessionId: runInput.sessionId,
        runId: runInput.runId,
      }

      if (sharedActiveRuns.has(activeRunKey)) {
        throw new Error(`Run ${runInput.runId} is already active`)
      }

      const session = input.conversation.getSession(runInput.sessionId)
      const controller = new AbortController()
      const queue = createEventQueue<RuntimeEvent>()
      const emit = (event: RuntimeEvent) => {
        queue.push(event)
      }
      const suspend = createRunSuspension({
        permission: input.permission,
        runId: runInput.runId,
        sessionId: session.id,
        policy: {
          write: "ask",
          edit: "ask",
          shell: "ask",
          ...input.permissionPolicy,
        },
        now,
        emit,
      })
      const activeRun = {
        ...activeRunKey,
        controller,
        suspend,
        emit,
      }
      sharedActiveRuns.add(activeRun)
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
        systemPrompt: input.systemPrompt ?? "You are the agent runtime.",
      }).finally(() => {
        suspend.cancel()
        sharedActiveRuns.delete(activeRunKey)
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
