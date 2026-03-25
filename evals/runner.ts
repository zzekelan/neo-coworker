import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ModelObserverPort, ModelProvider } from "../src/model"
import {
  createCliStorageComposition,
  createObservabilityRuntimeApi,
  createRuntime,
} from "../src/bootstrap"
import { createSessionRuntimeApi } from "../src/session"
import { EvalRunArtifactSchema, type EvalRunArtifact } from "./schemas/artifact"
import { gradeTraceExpectation, type EvalTraceGrade } from "./graders/trace"
import { EvalTaskSchema, type EvalTask } from "./schemas/task"

export type EvalProviderFactory = (input: {
  modelObserver?: ModelObserverPort
}) => ModelProvider

export type EvalRunResult = {
  artifact: EvalRunArtifact
  traceGrade: EvalTraceGrade
}

export async function runEvalTask(input: {
  task: EvalTask
  createProvider: EvalProviderFactory
  now?: () => number
}): Promise<EvalRunResult> {
  const task = EvalTaskSchema.parse(input.task)
  const now = input.now ?? Date.now
  const workspaceRoot = await prepareWorkspace(task)
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

    const handle = await runtime.run({
      sessionId: session.id,
      runId: started.run.id,
    })
    const runtimeEvents = await collectRuntimeEvents(handle.events, {
      autoReplyPermission: task.autoReplyPermission,
      respondPermission(inputValue) {
        handle.respondPermission(inputValue)
      },
    })
    const run = storage.repository.runs.get(started.run.id)

    const artifact = EvalRunArtifactSchema.parse({
      taskId: task.id,
      workspaceRoot,
      sessionId: session.id,
      runId: run.id,
      runStatus: run.status,
      runtimeEvents,
      transcript: storage.repository.messages.listSessionTranscript(session.id),
      trace: observability?.exportRunTrace(run.id) ?? null,
    })

    return {
      artifact,
      traceGrade: gradeTraceExpectation({
        artifact,
        expectation: task.traceExpectation,
      }),
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
    respondPermission(input: { requestId: string; decision: "allow" | "deny" }): void
  },
) {
  const collected: Array<{ type: string }> = []

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
