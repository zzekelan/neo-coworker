import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

declare const Bun: {
  write(path: string, data: string): Promise<number>
}

import { createRuntime } from "../../src/bootstrap"
import { createObservabilityRepository, createObservabilityRuntimeApi } from "../../src/observability"
import {
  createPermissionAllowlistStore,
  createPermissionRepository,
  type PermissionObserverEvent,
} from "../../src/permission"
import {
  createSessionRepository,
  createSessionRunService,
  openSessionDatabase,
} from "../../src/session"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("integration: enhanced permission wiring", () => {
  test("dangerous shell requests force ask even when base policy is allow", async () => {
    const harness = await createHarness("permission-enhanced-danger")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_enhanced_danger",
      messageId: "message_permission_enhanced_danger",
      prompt: "Delete a temp directory",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell_rm",
            name: "shell",
            inputText: JSON.stringify({ command: "rm -rf /tmp/task27-danger", description: "delete temp" }),
          }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      permissionPolicy: { shell: "allow" },
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    expect(permissionEvent).toMatchObject({
      toolName: "shell",
      reason: "shell rm -rf /tmp/task27-danger",
    })
    expect(requests).toHaveLength(1)
  })

  test("safe allowlisted requests auto-approve without prompting", async () => {
    const harness = await createHarness("permission-enhanced-allowlist")
    await createPermissionAllowlistStore({
      database: harness.database,
      workspaceRoot: harness.workspaceRoot,
      now: harness.now,
      observer: createPermissionObserverBridge(harness.observability.permissionObserver),
    }).add({
      toolName: "shell",
      pattern: "git status",
      reason: "safe shell read",
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_enhanced_allowlist",
      messageId: "message_permission_enhanced_allowlist",
      prompt: "Check git status",
    })

    const runtime = createRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell_git_status",
            name: "shell",
            inputText: JSON.stringify({ command: "git status", description: "show status" }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Status complete." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      permissionPolicy: { shell: "ask" },
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    const events = await collectEvents(handle.events)

    expect(events.some(isPermissionRequestedEvent)).toBe(false)
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toEqual([])

    const trace = harness.observability.exportRunTrace(started.run.id)
    const permissionEvents = trace?.events.filter((event) => event.source === "permission") ?? []
    expect(permissionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "allowlist.checked" }),
      expect.objectContaining({ eventType: "allowlist.auto_approved" }),
    ]))
  })

  test("dangerous requests are not auto-approved by allowlist", async () => {
    const harness = await createHarness("permission-enhanced-risk-wins")
    await createPermissionAllowlistStore({
      database: harness.database,
      workspaceRoot: harness.workspaceRoot,
      now: harness.now,
      observer: createPermissionObserverBridge(harness.observability.permissionObserver),
    }).add({
      toolName: "shell",
      pattern: "rm -rf /tmp/task27-danger-win",
      reason: "should not bypass risk",
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_enhanced_risk_wins",
      messageId: "message_permission_enhanced_risk_wins",
      prompt: "Try dangerous rm",
    })

    const runtime = createRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell_rm_allowlisted",
            name: "shell",
            inputText: JSON.stringify({ command: "rm -rf /tmp/task27-danger-win", description: "dangerous" }),
          }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      permissionPolicy: { shell: "ask" },
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    expect(permissionEvent.reason).toBe("shell rm -rf /tmp/task27-danger-win")
    const trace = harness.observability.exportRunTrace(started.run.id)
    const permissionEvents = trace?.events.filter((event) => event.source === "permission") ?? []
    expect(permissionEvents.some((event) => event.eventType === "allowlist.auto_approved")).toBe(false)
  })
})

async function createHarness(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  const databasePath = join(directory, "agent.sqlite")
  await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined)
  await Bun.write(join(directory, ".keep"), "")
  const database = openSessionDatabase(databasePath)
  openDatabases.push(database)
  const now = createMonotonicClock()
  const repository = createSessionRepository({ database, now })
  const permissionRepository = createPermissionRepository({ database, now })
  const observabilityRepository = createObservabilityRepository({ database, now })
  const observability = createObservabilityRuntimeApi({ repository: observabilityRepository, now })
  const service = createSessionRunService({ repository, now })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    database,
    workspaceRoot,
    repository,
    permissionRepository,
    observability,
    service,
    session,
    now,
  }
}

function startPromptRun(input: {
  repository: ReturnType<typeof createSessionRepository>
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
  messageId: string
  prompt: string
}) {
  const started = input.service.startRun({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
  })

  input.repository.parts.create({
    sessionId: input.sessionId,
    runId: started.run.id,
    messageId: started.message.id,
    kind: "text",
    sequence: 0,
    text: input.prompt,
  })

  return started
}

function createTurnProvider(
  requests: ProviderTurnRequest[],
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
) {
  let index = 0

  return createModelProvider({
    runtime: createModelRuntimeApi({
      async *streamTurn(request: ProviderTurnRequest) {
        requests.push(request)
        const turn = turns[index]
        index += 1

        if (!turn) {
          throw new Error(`Unexpected provider turn ${index}`)
        }

        for await (const event of turn(request)) {
          yield event
        }
      },
    }),
  })
}

async function collectEvents(events: AsyncIterable<unknown>) {
  const collected: unknown[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

async function waitForPermissionRequest(iterator: AsyncIterator<unknown>) {
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      throw new Error("Expected permission request event")
    }

    if (isPermissionRequestedEvent(next.value)) {
      return next.value
    }
  }
}

function isPermissionRequestedEvent(event: unknown): event is {
  type: "permission.requested"
  requestId: string
  toolName: string
  reason: string
} {
  return !!event && typeof event === "object" && "type" in event && event.type === "permission.requested"
}

function createMonotonicClock() {
  let current = 100
  return () => {
    current += 1
    return current
  }
}

function createPermissionObserverBridge(observer: { recordPermissionEvent(event: { sessionId: string; runId: string; type: string; [key: string]: unknown }): unknown }) {
  return {
    recordPermissionEvent(event: PermissionObserverEvent) {
      if (!("sessionId" in event) || !("runId" in event)) {
        return
      }

      observer.recordPermissionEvent(event)
    },
  }
}
