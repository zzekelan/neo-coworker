import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import type { ModelObserverPort, ModelProvider } from "../src/model"
import {
  createCliStorageComposition,
  createObservabilityRuntimeApi,
  createOrchestrationActiveRunRegistry,
  createRuntime,
  type OrchestrationActiveRunRegistry,
  type RunHandle,
} from "../src/bootstrap"
import { createSessionRuntimeApi } from "../src/session"
import { EvalRunArtifactSchema, type EvalRunArtifact } from "./schemas/artifact"
import { gradeOutcomeExpectation, type EvalOutcomeGrade } from "./graders/outcome"
import { gradeProtocolExpectation, type EvalProtocolGrade } from "./graders/protocol"
import { gradeTraceExpectation, type EvalTraceGrade } from "./graders/trace"
import { gradeToolPolicyExpectation, type EvalToolPolicyGrade } from "./graders/tool-policy"
import { EvalTaskSchema, type EvalTask } from "./schemas/task"

export type EvalProviderFactory = (input: {
  modelObserver?: ModelObserverPort
}) => ModelProvider

export type EvalRunGrades = {
  outcome: EvalOutcomeGrade
  protocol: EvalProtocolGrade
  toolPolicy: EvalToolPolicyGrade
  trace: EvalTraceGrade
}

export type EvalRunResult = {
  artifact: EvalRunArtifact
  grades: EvalRunGrades
  pass: boolean
}

export async function runEvalTask(input: {
  task: EvalTask
  createProvider: EvalProviderFactory
  activeRuns?: OrchestrationActiveRunRegistry
  onRunStarted?(input: {
    storageIdentity: string
    sessionId: string
    runId: string
  }): void
  now?: () => number
}): Promise<EvalRunResult> {
  const task = EvalTaskSchema.parse(input.task)
  const now = input.now ?? Date.now
  const workspaceRoot = await prepareWorkspace(task)
  const activeRuns = input.activeRuns ?? createOrchestrationActiveRunRegistry()
  const storage = createCliStorageComposition({
    workspaceRoot,
    now,
  })
  const observability = storage.observabilityRepository
    ? createObservabilityRuntimeApi({
        repository: storage.observabilityRepository,
        now,
      })
    : undefined
  const provider = input.createProvider({
    modelObserver: observability?.modelObserver,
  })
  const sessionProvider = createSessionRuntimeApi({
    repository: storage.repository,
    now,
  })
  const runtime = createRuntime({
    provider,
    repository: storage.repository,
    permissionRepository: storage.permissionRepository,
    observability,
    activeRuns,
    permissionPolicy: task.permissionPolicy,
    now,
  })

  try {
    const session = storage.repository.sessions.create({
      directory: workspaceRoot,
      workspaceRoot,
      createdAt: now(),
    })
    const started = sessionProvider.runs.start({
      sessionId: session.id,
      trigger: "cli",
      createdAt: now(),
      messageCreatedAt: now(),
    })
    storage.repository.parts.create({
      sessionId: session.id,
      runId: started.run.id,
      messageId: started.message.id,
      kind: "text",
      sequence: 0,
      text: task.prompt,
      createdAt: now(),
    })
    input.onRunStarted?.({
      storageIdentity: storage.repository.storageIdentity,
      sessionId: session.id,
      runId: started.run.id,
    })

    const handle = await runtime.run({
      sessionId: session.id,
      runId: started.run.id,
    })
    try {
      const runtimeEvents = await collectRuntimeEvents(handle.events, {
        autoReplyPermission: task.autoReplyPermission,
        cancelOnRuntimeEventType: task.control.cancelOnRuntimeEventType,
        cancelRun() {
          handle.cancel()
        },
        respondPermission(inputValue) {
          handle.respondPermission(inputValue)
        },
      })
      const run = storage.repository.runs.get(started.run.id)
      const trace = observability?.exportRunTrace(run.id) ?? null
      const outcome = await buildOutcome({
        task,
        workspaceRoot,
        run,
      })

      const artifact = EvalRunArtifactSchema.parse({
        taskId: task.id,
        workspaceRoot,
        sessionId: session.id,
        runId: run.id,
        runStatus: run.status,
        runtimeEvents,
        transcript: storage.repository.messages.listSessionTranscript(session.id),
        trace,
        outcome,
        metrics: deriveMetrics(trace),
      })
      const grades: EvalRunGrades = {
        outcome: gradeOutcomeExpectation({
          artifact,
          expectation: task.outcomeExpectation,
        }),
        protocol: gradeProtocolExpectation({
          artifact,
          expectation: task.protocolExpectation,
        }),
        toolPolicy: gradeToolPolicyExpectation({
          artifact,
          expectation: task.toolPolicyExpectation,
        }),
        trace: gradeTraceExpectation({
          artifact,
          expectation: task.traceExpectation,
        }),
      }

      return {
        artifact,
        grades,
        pass: Object.values(grades).every((grade) => grade.pass),
      }
    } catch (error) {
      await cancelEvalRun({
        handle,
        activeRuns,
        storageIdentity: storage.repository.storageIdentity,
        sessionId: session.id,
        runId: started.run.id,
      })
      throw error
    }
  } finally {
    storage.close()
    if (workspaceRoot !== task.workspaceRoot) {
      await rm(dirname(workspaceRoot), { force: true, recursive: true })
    }
  }
}

async function prepareWorkspace(task: EvalTask) {
  if (!task.copyWorkspace) {
    return task.workspaceRoot
  }

  const root = await mkdtemp(join(tmpdir(), `eval-${basename(task.workspaceRoot)}-`))
  const workspaceRoot = join(root, "workspace")
  await cp(task.workspaceRoot, workspaceRoot, {
    recursive: true,
  })
  return workspaceRoot
}

async function collectRuntimeEvents(
  events: AsyncIterable<unknown>,
  input: {
    autoReplyPermission?: "allow" | "deny"
    cancelOnRuntimeEventType?: string
    cancelRun?(): void
    respondPermission(input: { requestId: string; decision: "allow" | "deny" }): void
  },
) {
  const collected: Array<{ type: string }> = []
  let cancelRequested = false

  for await (const rawEvent of events) {
    if (
      typeof rawEvent === "object" &&
      rawEvent !== null &&
      "type" in rawEvent &&
      typeof rawEvent.type === "string"
    ) {
      collected.push({
        type: rawEvent.type,
      })

      if (
        !cancelRequested &&
        input.cancelOnRuntimeEventType &&
        rawEvent.type === input.cancelOnRuntimeEventType
      ) {
        cancelRequested = true
        input.cancelRun?.()
      }

      if (
        rawEvent.type === "permission.requested" &&
        "requestId" in rawEvent &&
        typeof rawEvent.requestId === "string"
      ) {
        if (!input.autoReplyPermission) {
          throw new Error(
            `Eval runner received permission request ${rawEvent.requestId} without autoReplyPermission`,
          )
        }

        input.respondPermission({
          requestId: rawEvent.requestId,
          decision: input.autoReplyPermission,
        })
      }
    }
  }

  return collected
}

async function cancelEvalRun(input: {
  handle: RunHandle
  activeRuns: OrchestrationActiveRunRegistry
  storageIdentity: string
  sessionId: string
  runId: string
}) {
  input.handle.cancel()

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      !input.activeRuns.has({
        storageIdentity: input.storageIdentity,
        sessionId: input.sessionId,
        runId: input.runId,
      })
    ) {
      return
    }

    await Bun.sleep(0)
  }
}

async function buildOutcome(input: {
  task: EvalTask
  workspaceRoot: string
  run: {
    status: EvalRunArtifact["runStatus"]
    errorText: string | null
  }
}) {
  return {
    runStatus: input.run.status,
    errorText: input.run.errorText,
    watchedFiles: await Promise.all(
      input.task.outcomeExpectation.watchedFiles.map(async (fileExpectation) =>
        readObservedFile(input.workspaceRoot, fileExpectation.path),
      ),
    ),
  }
}

async function readObservedFile(workspaceRoot: string, relativePath: string) {
  const target = await resolveObservedFilePath(workspaceRoot, relativePath)

  if (!target.exists) {
    return {
      path: relativePath,
      exists: false,
      content: null,
    }
  }

  return {
    path: relativePath,
    exists: true,
    content: await readFile(target.path, "utf8"),
  }
}

function deriveMetrics(trace: EvalRunArtifact["trace"]) {
  const events = trace?.events ?? []
  const terminalEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === "run.completed" ||
        event.eventType === "run.failed" ||
        event.eventType === "run.cancelled",
    )

  return {
    totalRunDurationMs:
      events.length > 0
        ? Math.max(events[events.length - 1]!.createdAt - events[0]!.createdAt, 0)
        : null,
    modelTurnCount: events.filter((event) => event.eventType === "model.turn.requested").length,
    toolCallCount: events.filter((event) => event.eventType === "tool.call.completed").length,
    permissionWaitCount: events.filter((event) => event.eventType === "permission.requested").length,
    retryCount: events.filter((event) => event.eventType === "model.turn.retrying").length,
    terminalEventType:
      terminalEvent?.eventType === "run.completed" ||
      terminalEvent?.eventType === "run.failed" ||
      terminalEvent?.eventType === "run.cancelled"
        ? terminalEvent.eventType
        : null,
  }
}

async function resolveObservedFilePath(workspaceRoot: string, relativePath: string) {
  const root = await realpath(resolve(workspaceRoot))
  const target = resolve(root, relativePath)

  assertPathInsideWorkspace({
    root,
    target,
    relativePath,
  })

  try {
    const resolvedTarget = await realpath(target)
    assertPathInsideWorkspace({
      root,
      target: resolvedTarget,
      relativePath,
    })

    return {
      exists: true,
      path: resolvedTarget,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }

    const existingParent = await resolveExistingParent(target)
    assertPathInsideWorkspace({
      root,
      target: existingParent,
      relativePath,
    })

    return {
      exists: false,
      path: target,
    }
  }
}

async function resolveExistingParent(target: string) {
  let current = dirname(target)

  while (true) {
    try {
      return await realpath(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }

      const next = dirname(current)
      if (next === current) {
        throw error
      }

      current = next
    }
  }
}

function assertPathInsideWorkspace(input: {
  root: string
  target: string
  relativePath: string
}) {
  if (input.target === input.root || input.target.startsWith(`${input.root}${sep}`)) {
    return
  }

  throw new Error(`Eval watched file path must stay inside workspace: ${input.relativePath}`)
}
