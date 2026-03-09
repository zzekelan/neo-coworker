import type { Provider } from "../providers/types"
import { assertRunStatusTransition } from "../run"
import { createSessionRunService } from "../session"
import { createRuntime } from "../runtime/runtime"
import type { PermissionMode, PermissionResponse } from "../runtime/permissions"
import type { RunTrigger, StorageRepository } from "../storage"
import { buildSessionSnapshot, createServerEventBus } from "./events"
import { createObservedRepository } from "./repository-events"

export function createServerApp(input: {
  provider: Provider
  repository: StorageRepository
  permissionPolicy?: Partial<Record<"write" | "edit" | "shell", PermissionMode>>
  systemPrompt?: string
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const eventBus = createServerEventBus({
    now,
  })
  const repository = createObservedRepository({
    repository: input.repository,
    events: eventBus,
  })
  const sessionRuns = createSessionRunService({
    repository,
    now,
  })
  const runtime = createRuntime({
    provider: input.provider,
    repository,
    permissionPolicy: input.permissionPolicy,
    systemPrompt: input.systemPrompt,
    now,
  })

  async function startRun(runInput: {
    sessionId: string
    prompt: string
    trigger?: RunTrigger
    runId?: string
    messageId?: string
  }) {
    const createdAt = now()
    const messageCreatedAt = now()
    const started = sessionRuns.startRun({
      sessionId: runInput.sessionId,
      trigger: runInput.trigger ?? "prompt",
      runId: runInput.runId,
      messageId: runInput.messageId,
      createdAt,
      messageCreatedAt,
    })

    repository.parts.create({
      sessionId: runInput.sessionId,
      runId: started.run.id,
      messageId: started.message.id,
      kind: "text",
      sequence: 0,
      text: runInput.prompt,
      createdAt: now(),
    })

    const handle = await runtime.run({
      sessionId: runInput.sessionId,
      runId: started.run.id,
    })

    void drainRunHandle(handle)

    return started
  }

  return {
    events: eventBus,
    sessions: {
      create(sessionInput: {
        directory: string
        workspaceRoot?: string
      }) {
        return repository.sessions.create({
          directory: sessionInput.directory,
          workspaceRoot: sessionInput.workspaceRoot ?? sessionInput.directory,
          createdAt: now(),
        })
      },
      list() {
        return repository.sessions.list()
      },
      get(sessionId: string) {
        return buildSessionSnapshot(repository, sessionId)
      },
      transcript(sessionId: string) {
        return repository.messages.listSessionTranscript(sessionId)
      },
    },
    runs: {
      start: startRun,
      list(sessionId: string) {
        return repository.runs.listBySession(sessionId)
      },
      get(runId: string) {
        const run = repository.runs.get(runId)
        return {
          run,
          permissionRequests: repository.permissionRequests.listByRun(runId),
        }
      },
      cancel(runId: string) {
        const run = repository.runs.get(runId)
        assertRunStatusTransition(run, "cancelled")
        runtime.cancelRun(runId)
        return repository.runs.get(runId)
      },
    },
    permissions: {
      reply(response: PermissionResponse) {
        runtime.respondPermission(response)
        const permissionRequest = repository.permissionRequests.get(response.requestId)
        return {
          permissionRequest,
          run: repository.runs.get(permissionRequest.runId),
        }
      },
    },
    subscribe(filter?: Parameters<typeof eventBus.subscribe>[0]) {
      return eventBus.subscribe(filter)
    },
    close() {
      eventBus.close()
    },
  }
}

async function drainRunHandle(handle: Awaited<ReturnType<ReturnType<typeof createRuntime>["run"]>>) {
  try {
    for await (const _event of handle.events) {
      // Server-side state changes are broadcast from repository writes, so runtime
      // events only need to be drained to avoid unconsumed per-run queues.
    }
  } catch {
    // Runtime state changes are already persisted and surfaced through the repository.
  }
}
