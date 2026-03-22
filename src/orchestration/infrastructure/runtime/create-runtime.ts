import { createOrchestrationStepService } from "../../application/step-service"
import type { RuntimeEvent } from "../../application/event"
import type { OrchestrationRunHandle } from "../../application/handle"
import type { OrchestrationModelPort } from "../../application/ports/model"
import type {
  OrchestrationPermissionPort,
  OrchestrationPermissionResponse,
} from "../../application/ports/permission"
import type { OrchestrationSessionPort } from "../../application/ports/session"
import type {
  OrchestrationToolPortFactory,
} from "../../application/ports/tool"
import type { OrchestrationPermissionPolicy } from "../../application/permission"
import {
  type OrchestrationActiveRunRegistry,
} from "./active-run-registry"
import { createEventQueue } from "./event-queue"
import { runOrchestrationLoop } from "./loop"
import {
  createRunSuspension,
  PermissionRequestNotAwaitingActiveRuntimeError,
} from "./run-suspension"

const DEFAULT_SYSTEM_PROMPT = "You are the agent runtime."

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

export function createOrchestrationRuntimeApi(input: CreateOrchestrationRuntimeApiInput) {
  const now = input.now ?? Date.now
  const activeRuns = input.activeRuns
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
        policy: input.permissionPolicy,
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
        respondPermission(response: OrchestrationPermissionResponse) {
          respondPermission(response)
        },
      }
    },
    respondPermission,
    cancelRun,
  }
}

export type OrchestrationRuntimeApi = ReturnType<typeof createOrchestrationRuntimeApi>
