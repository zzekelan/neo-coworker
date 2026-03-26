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
  OrchestrationToolPort,
  OrchestrationToolPortFactory,
} from "../../application/ports/tool"
import type { OrchestrationRuntimeObserverPort } from "../../application/ports/runtime-observer"
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
  runtimeObserver?: OrchestrationRuntimeObserverPort
}

export type OrchestrationRunInput = {
  sessionId: string
  runId: string
}

type PendingToolCallSnapshot = {
  callId: string
  toolName: string
  inputText: string
}

export function createOrchestrationRuntimeApi(input: CreateOrchestrationRuntimeApiInput) {
  const now = input.now ?? Date.now
  const activeRuns = input.activeRuns
  const stepService = createOrchestrationStepService({
    session: input.session,
    model: input.model,
    now,
  })

  function buildActiveRunKey(sessionId: string, runId: string) {
    return {
      storageIdentity: input.session.storageIdentity,
      sessionId,
      runId,
    }
  }

  function createActiveRunExecution(inputValue: {
    sessionId: string
    runId: string
    replayPermission?: {
      requestId: string
      toolName: string
      reason: string
      decision: OrchestrationPermissionResponse["decision"]
    }
  }) {
    const activeRunKey = buildActiveRunKey(inputValue.sessionId, inputValue.runId)

    if (activeRuns.has(activeRunKey)) {
      throw new Error(`Run ${inputValue.runId} is already active`)
    }

    const session = input.session.getSession(inputValue.sessionId)
    const controller = new AbortController()
    const queue = createEventQueue<RuntimeEvent>()
    const emit = (event: RuntimeEvent) => {
      queue.push(event)
      try {
        input.runtimeObserver?.recordRuntimeEvent?.({
          sessionId: session.id,
          runId: inputValue.runId,
          event,
          occurredAt: now(),
        })
      } catch {
        // Observability must not alter the live event stream.
      }
    }
    const suspend = createRunSuspension({
      permission: input.permission,
      runId: inputValue.runId,
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
    let replayPermissionConsumed = inputValue.replayPermission == null

    activeRuns.add(activeRun)

    const tools = input.tools.create({
      requestPermission(request) {
        if (
          inputValue.replayPermission &&
          !replayPermissionConsumed &&
          request.toolName === inputValue.replayPermission.toolName &&
          request.reason === inputValue.replayPermission.reason
        ) {
          replayPermissionConsumed = true
          return {
            requestId: inputValue.replayPermission.requestId,
            decision: inputValue.replayPermission.decision,
          }
        }

        return suspend.requestPermission(request)
      },
      sessionId: session.id,
      runId: inputValue.runId,
    })

    return {
      activeRunKey,
      controller,
      emit,
      queue,
      session,
      suspend,
      tools,
      wasReplayPermissionConsumed() {
        return replayPermissionConsumed
      },
      cleanup() {
        suspend.cancel()
        activeRuns.delete(activeRunKey)
        queue.close()
      },
    }
  }

  async function continueRunLoop(inputValue: {
    sessionId: string
    runId: string
    signal: AbortSignal
    emit: (event: RuntimeEvent) => void
    tools: OrchestrationToolPort
    workspaceRoot: string
  }) {
    while (true) {
      if (inputValue.signal.aborted) {
        stepService.cancelRun({
          runId: inputValue.runId,
          emit: inputValue.emit,
        })
        return
      }

      const outcome = await stepService.executeStep({
        sessionId: inputValue.sessionId,
        runId: inputValue.runId,
        tools: inputValue.tools,
        workspaceRoot: inputValue.workspaceRoot,
        systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        signal: inputValue.signal,
        emit: inputValue.emit,
      })

      if (outcome.status === "repeat") {
        continue
      }

      if (outcome.status === "failed") {
        stepService.failRun({
          runId: inputValue.runId,
          error: outcome.error,
          emit: inputValue.emit,
        })
        return
      }

      if (outcome.status === "cancelled") {
        stepService.cancelRun({
          runId: inputValue.runId,
          emit: inputValue.emit,
        })
        return
      }

      stepService.completeRun({
        runId: inputValue.runId,
        emit: inputValue.emit,
      })
      return
    }
  }

  async function executeRecoveredPendingTool(inputValue: {
    sessionId: string
    runId: string
    signal: AbortSignal
    emit: (event: RuntimeEvent) => void
    tools: OrchestrationToolPort
    workspaceRoot: string
    pendingToolCall: PendingToolCallSnapshot
    wasReplayPermissionConsumed(): boolean
  }) {
    let args: unknown

    try {
      args = JSON.parse(inputValue.pendingToolCall.inputText)
    } catch (error) {
      appendRecoveredAssistantPart({
        session: input.session,
        sessionId: inputValue.sessionId,
        runId: inputValue.runId,
        now,
        part: {
          kind: "error",
          text: `Malformed tool arguments for ${inputValue.pendingToolCall.toolName}: ${stepService.getErrorMessage(error)}`,
          data: {
            source: "tool",
            callId: inputValue.pendingToolCall.callId,
            toolName: inputValue.pendingToolCall.toolName,
          },
        },
      })
      return "repeat" as const
    }

    try {
      const result = await inputValue.tools.execute({
        toolName: inputValue.pendingToolCall.toolName,
        args,
        workspaceRoot: inputValue.workspaceRoot,
        signal: inputValue.signal,
      })

      if (inputValue.signal.aborted) {
        throw createAbortError()
      }

      if (!inputValue.wasReplayPermissionConsumed()) {
        throw new Error(
          `Recovered tool ${inputValue.pendingToolCall.toolName} did not consume the pending permission reply`,
        )
      }

      appendRecoveredAssistantPart({
        session: input.session,
        sessionId: inputValue.sessionId,
        runId: inputValue.runId,
        now,
        part: {
          kind: "tool_result",
          text: result.output,
          data: {
            callId: inputValue.pendingToolCall.callId,
            toolName: inputValue.pendingToolCall.toolName,
            output: result.output,
          },
        },
      })
      inputValue.emit({
        type: "tool.call.completed",
        callId: inputValue.pendingToolCall.callId,
        name: inputValue.pendingToolCall.toolName,
        output: result.output,
      })
      return "repeat" as const
    } catch (error) {
      if (stepService.isAbortError(error, inputValue.signal)) {
        throw error
      }

      appendRecoveredAssistantPart({
        session: input.session,
        sessionId: inputValue.sessionId,
        runId: inputValue.runId,
        now,
        part: {
          kind: "error",
          text: `Tool ${inputValue.pendingToolCall.toolName} failed: ${stepService.getErrorMessage(error)}`,
          data: {
            source: "tool",
            callId: inputValue.pendingToolCall.callId,
            toolName: inputValue.pendingToolCall.toolName,
          },
        },
      })

      return isToolPermissionDeniedError(error) ? ("cancelled" as const) : ("repeat" as const)
    }
  }

  function resumeDetachedPermission(response: OrchestrationPermissionResponse) {
    const permissionRequest = input.permission.getPermissionRequest(response.requestId)
    const run = input.session.getRun(permissionRequest.runId)
    const activeRunKey = buildActiveRunKey(permissionRequest.sessionId, permissionRequest.runId)

    if (activeRuns.has(activeRunKey)) {
      respondPermission(response)
      return
    }

    if (permissionRequest.status !== "pending" || run.status !== "waiting_permission") {
      throw new PermissionRequestNotAwaitingActiveRuntimeError({
        requestId: permissionRequest.id,
        runId: permissionRequest.runId,
        sessionId: permissionRequest.sessionId,
      })
    }

    const pendingToolCall = findPendingToolCall({
      transcript: input.session.listTranscript(permissionRequest.sessionId),
      runId: permissionRequest.runId,
    })

    if (pendingToolCall.toolName !== permissionRequest.toolName) {
      throw new Error(
        `Pending tool call ${pendingToolCall.toolName} does not match permission request ${permissionRequest.toolName}`,
      )
    }

    input.permission.respondPermission({
      requestId: response.requestId,
      decision: response.decision,
      resolvedAt: now(),
    })

    const execution = createActiveRunExecution({
      sessionId: permissionRequest.sessionId,
      runId: permissionRequest.runId,
      replayPermission: {
        requestId: permissionRequest.id,
        toolName: permissionRequest.toolName,
        reason: permissionRequest.reason,
        decision: response.decision,
      },
    })

    void (async () => {
      try {
        const recoveredOutcome = await executeRecoveredPendingTool({
          sessionId: permissionRequest.sessionId,
          runId: permissionRequest.runId,
          signal: execution.controller.signal,
          emit: execution.emit,
          tools: execution.tools,
          workspaceRoot: execution.session.workspaceRoot,
          pendingToolCall,
          wasReplayPermissionConsumed: execution.wasReplayPermissionConsumed,
        })

        if (recoveredOutcome === "cancelled") {
          stepService.cancelRun({
            runId: permissionRequest.runId,
            emit: execution.emit,
          })
          return
        }

        await continueRunLoop({
          sessionId: permissionRequest.sessionId,
          runId: permissionRequest.runId,
          signal: execution.controller.signal,
          emit: execution.emit,
          tools: execution.tools,
          workspaceRoot: execution.session.workspaceRoot,
        })
      } catch (error) {
        if (stepService.isAbortError(error, execution.controller.signal)) {
          stepService.cancelRun({
            runId: permissionRequest.runId,
            emit: execution.emit,
          })
          return
        }

        stepService.failRun({
          runId: permissionRequest.runId,
          error: stepService.getErrorMessage(error),
          emit: execution.emit,
        })
      }
    })().finally(() => {
      execution.cleanup()
    })
  }

  function respondPermission(response: Parameters<OrchestrationRunHandle["respondPermission"]>[0]) {
    const permissionRequest = input.permission.getPermissionRequest(response.requestId)
    const activeRun = activeRuns.get(
      buildActiveRunKey(permissionRequest.sessionId, permissionRequest.runId),
    )

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
    const activeRun = activeRuns.get(buildActiveRunKey(run.sessionId, runId))
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

  function detachRun(runId: string) {
    const run = input.session.getRun(runId)
    const activeRun = activeRuns.get(buildActiveRunKey(run.sessionId, runId))

    if (!activeRun || run.status !== "waiting_permission") {
      return
    }

    activeRun.suspend.detach()
  }

  return {
    async run(runInput: OrchestrationRunInput): Promise<OrchestrationRunHandle> {
      const execution = createActiveRunExecution({
        sessionId: runInput.sessionId,
        runId: runInput.runId,
      })

      void runOrchestrationLoop({
        sessionId: execution.session.id,
        runId: runInput.runId,
        stepService,
        emit: execution.emit,
        signal: execution.controller.signal,
        tools: execution.tools,
        workspaceRoot: execution.session.workspaceRoot,
        systemPrompt: input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      }).finally(() => {
        execution.cleanup()
      })

      return {
        events: execution.queue.stream(),
        cancel() {
          cancelRun(runInput.runId)
        },
        respondPermission(response: OrchestrationPermissionResponse) {
          respondPermission(response)
        },
      }
    },
    detachRun,
    resumeDetachedPermission,
    respondPermission,
    cancelRun,
  }
}

export type OrchestrationRuntimeApi = ReturnType<typeof createOrchestrationRuntimeApi>

function appendRecoveredAssistantPart(input: {
  session: OrchestrationSessionPort
  sessionId: string
  runId: string
  now: () => number
  part: {
    kind: string
    text?: string | null
    data?: unknown
  }
}) {
  const sequence = getNextMessageSequence(input.session.listTranscript(input.sessionId), input.runId)
  const message = input.session.createAssistantMessage({
    sessionId: input.sessionId,
    runId: input.runId,
    sequence,
    createdAt: input.now(),
  })

  input.session.createMessagePart({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: message.id,
    kind: input.part.kind,
    sequence: 0,
    text: input.part.text,
    data: input.part.data,
    createdAt: input.now(),
  })
}

function findPendingToolCall(input: {
  transcript: ReturnType<OrchestrationSessionPort["listTranscript"]>
  runId: string
}): PendingToolCallSnapshot {
  const unresolved = new Map<string, PendingToolCallSnapshot>()
  const orderedCallIds: string[] = []

  for (const message of input.transcript) {
    if (message.runId !== input.runId || message.role !== "assistant") {
      continue
    }

    for (const part of message.parts) {
      if (part.kind === "tool_call") {
        const callId = readObjectString(part.data, "callId")
        if (!callId) {
          continue
        }

        unresolved.set(callId, {
          callId,
          toolName: readObjectString(part.data, "toolName") ?? "unknown",
          inputText: readObjectString(part.data, "inputText") ?? part.text ?? "",
        })
        orderedCallIds.push(callId)
        continue
      }

      const resolvedCallId = readResolvedToolCallId(part)
      if (resolvedCallId) {
        unresolved.delete(resolvedCallId)
      }
    }
  }

  const pendingCallId = [...orderedCallIds].reverse().find((callId) => unresolved.has(callId))
  if (!pendingCallId) {
    throw new Error(`Run ${input.runId} has no unresolved tool call to resume`)
  }

  return unresolved.get(pendingCallId)!
}

function readResolvedToolCallId(
  part: ReturnType<OrchestrationSessionPort["listTranscript"]>[number]["parts"][number],
) {
  if (part.kind === "tool_result") {
    return readObjectString(part.data, "callId")
  }

  if (part.kind === "error" && readObjectString(part.data, "source") === "tool") {
    return readObjectString(part.data, "callId")
  }

  return null
}

function getNextMessageSequence(
  transcript: ReturnType<OrchestrationSessionPort["listTranscript"]>,
  runId: string,
) {
  const highestSequence = transcript
    .filter((message) => message.runId === runId)
    .reduce((value, message) => Math.max(value, message.sequence), -1)

  return highestSequence + 1
}

function readObjectString(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "string" ? candidate : null
}

function createAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function isToolPermissionDeniedError(error: unknown) {
  return error instanceof Error && error.name === "ToolPermissionDeniedError"
}
