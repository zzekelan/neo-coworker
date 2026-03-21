import type { RuntimeEvent } from "../../application/event"
import type { OrchestrationToolPort } from "../../application/ports/tool"
import { createOrchestrationStepService } from "../../application/step-service"

export type OrchestrationLoopInput = {
  sessionId: string
  runId: string
  signal: AbortSignal
  emit: (event: RuntimeEvent) => void
  tools: OrchestrationToolPort
  workspaceRoot: string
  systemPrompt: string
  stepService: ReturnType<typeof createOrchestrationStepService>
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function runOrchestrationLoop(input: OrchestrationLoopInput) {
  try {
    input.stepService.initializeRun({
      sessionId: input.sessionId,
      runId: input.runId,
      emit: input.emit,
    })

    while (true) {
      if (input.signal.aborted) {
        input.stepService.cancelRun({
          runId: input.runId,
          emit: input.emit,
        })
        return
      }

      const outcome = await input.stepService.executeStep({
        sessionId: input.sessionId,
        runId: input.runId,
        tools: input.tools,
        workspaceRoot: input.workspaceRoot,
        systemPrompt: input.systemPrompt,
        signal: input.signal,
        emit: input.emit,
      })

      if (outcome.status === "repeat") {
        continue
      }

      if (outcome.status === "failed") {
        input.stepService.failRun({
          runId: input.runId,
          error: outcome.error,
          emit: input.emit,
        })
        return
      }

      if (outcome.status === "cancelled") {
        input.stepService.cancelRun({
          runId: input.runId,
          emit: input.emit,
        })
        return
      }

      input.stepService.completeRun({
        runId: input.runId,
        emit: input.emit,
      })
      return
    }
  } catch (error) {
    if (input.stepService.isAbortError(error, input.signal)) {
      input.stepService.cancelRun({
        runId: input.runId,
        emit: input.emit,
      })
      return
    }

    input.stepService.failRun({
      runId: input.runId,
      error: getErrorMessage(error),
      emit: input.emit,
    })
  }
}
