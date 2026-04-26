import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

declare const Bun: {
  write(path: string, data: string): Promise<number>
}

import { createRuntime } from "../../src/bootstrap"
import { createObservabilityRepository, createObservabilityRuntimeApi } from "../../src/observability"
import { createPermissionRepository } from "../../src/permission"
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
const testWithTimeout = test as unknown as (
  label: string,
  fn: () => Promise<void>,
  timeout: number,
) => void

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("integration: tool budget wiring", () => {
  test("keeps small tool results inline when aggregate turn budget is not exceeded", async () => {
    const harness = await createHarness("tool-budget-inline")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_tool_budget_inline",
      messageId: "message_tool_budget_inline",
      prompt: "Read a small file",
    })
    await Bun.write(join(harness.workspaceRoot, "small.txt"), "hello budget")

    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_small",
            name: "read",
            inputText: JSON.stringify({ path: "small.txt" }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Done." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      contextWindow: 1_000_000,
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    await collectEvents(handle.events)

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const toolResult = transcript
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "tool_result")

    expect(toolResult?.text).toContain("L1#542da631|hello budget")
    expect(toolResult?.text).not.toContain("Result spilled to")
  })

  test("spills the largest tool result to disk when the aggregate turn budget is exceeded", async () => {
    const harness = await createHarness("tool-budget-spill")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_tool_budget_spill",
      messageId: "message_tool_budget_spill",
      prompt: "Run several large shell commands",
    })

    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell_huge_a",
            name: "shell",
            inputText: JSON.stringify({
              command: "printf 'a%.0s' {1..150000}",
              description: "large output a",
            }),
          }
          yield {
            type: "tool.call",
            callId: "call_shell_huge_b",
            name: "shell",
            inputText: JSON.stringify({
              command: "printf 'b%.0s' {1..80000}",
              description: "large output b",
            }),
          }
        },
        async function* (request) {
          if (request.signal.aborted) {
            yield { type: "text.delta", text: "cancelled" } as const
          }
          await waitForAbort(request.signal)
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: harness.observability,
      permissionPolicy: {
        shell: "allow",
      },
      contextWindow: 1_000_000,
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    const iterator = handle.events[Symbol.asyncIterator]()
    await waitForToolCallCount(iterator, 2)
    handle.cancel()
    await collectRemainingEvents(iterator)

    const spilledDirectory = join(
      harness.workspaceRoot,
      ".ncoworker",
      "tool-results",
      harness.session.id,
      "shell",
    )
    const savedEntries = await readdir(spilledDirectory)
    expect(savedEntries.length).toBeGreaterThan(0)

    const trace = harness.observability.exportRunTrace(started.run.id)
    const toolEvents = trace?.events.filter((event) => event.source === "tool") ?? []
    expect(toolEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "budget.turn_over_budget" }),
      expect.objectContaining({ eventType: "budget.spill_largest" }),
    ]))

    const overBudgetEvent = toolEvents.find((event) => event.eventType === "budget.turn_over_budget")
    expect(overBudgetEvent?.data).toEqual({
      payload: {
        turnCumulativeSize: 230000,
        maxChars: 200000,
        trackedToolCount: 2,
      },
    })

    const spillEvent = toolEvents.find((event) => event.eventType === "budget.spill_largest")
    expect(spillEvent?.data).toEqual({
      payload: {
        toolName: "shell",
        spilledSize: 150000,
        previewLength: 500,
        diskPath: expect.stringContaining(`.ncoworker/tool-results/${harness.session.id}/shell/`),
        remainingBudget: expect.any(Number),
      },
    })
  })

  testWithTimeout("preserves per-tool resultSizeLimit handling before aggregate spill logic", async () => {
    const harness = await createHarness("tool-budget-size-limit")
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_tool_budget_size_limit",
      messageId: "message_tool_budget_size_limit",
      prompt: "Read a big file once",
    })
    await Bun.write(join(harness.workspaceRoot, "oversized.txt"), "x".repeat(130_000))

    const runtime = createRuntime({
      provider: createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_oversized",
            name: "read",
            inputText: JSON.stringify({ path: "oversized.txt" }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Done." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      contextWindow: 1_000_000,
      now: harness.now,
    })

    const handle = await runtime.run({ sessionId: harness.session.id, runId: started.run.id })
    await collectEvents(handle.events)

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const toolResult = transcript
      .flatMap((message) => message.parts)
      .find((part) => part.kind === "tool_result")

    expect(toolResult?.text).toContain("[Result truncated:")
    expect((toolResult?.data as { metadata?: { resultSizeLimit?: number } } | undefined)?.metadata?.resultSizeLimit)
      .toBe(100_000)
  }, 30000)
})

async function createHarness(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  const databasePath = join(directory, "agent.sqlite")
  await mkdir(workspaceRoot, { recursive: true })

  const now = createMonotonicClock()
  const database = openSessionDatabase(databasePath)
  openDatabases.push(database)
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
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
) {
  let index = 0

  return createModelProvider({
    runtime: createModelRuntimeApi({
      async *streamTurn(request: ProviderTurnRequest) {
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

async function waitForToolCallCount(iterator: AsyncIterator<unknown>, count: number) {
  let completed = 0

  while (true) {
    const next = await iterator.next()
    if (next.done) {
      break
    }

    const event = next.value
    if (isToolCallCompletedEvent(event)) {
      completed += 1
      if (completed >= count) {
        return
      }
    }
  }

  throw new Error(`Expected ${count} tool.call.completed event(s)`)
}

async function collectRemainingEvents(iterator: AsyncIterator<unknown>) {
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return
    }
  }
}

function isToolCallCompletedEvent(event: unknown): event is { type: "tool.call.completed" } {
  return !!event && typeof event === "object" && "type" in event && event.type === "tool.call.completed"
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function createMonotonicClock() {
  let current = 100
  return () => {
    current += 1
    return current
  }
}
