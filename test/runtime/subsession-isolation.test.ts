// @ts-expect-error Bun test types are provided by the Bun test runtime.
import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionRunService } from "../../src/session"
import {
  createPermissionRepository,
  type PermissionRepository,
} from "../../src/permission"
import {
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
  type SessionRepository as StorageRepository,
} from "../../src/session"
import {
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
  createModelRuntimeApi,
} from "../../src/model"
import { createRuntime } from "../../src/bootstrap"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("subsession transcript isolation", () => {
  test("keeps subagent runtime messages isolated from the parent transcript", async () => {
    const harness = await createHarness("subsession-isolation-runtime", true)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_parent",
      messageId: "message_parent_user",
      prompt: "Delegate README inspection through the agent tool",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_agent",
            name: "agent",
            inputText:
              '{"agent":"explore","prompt":"Inspect README.md and return only the final delegated summary."}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain(
            "Inspect README.md and return only the final delegated summary.",
          )
          expect(requestText).not.toContain("Delegate README inspection through the agent tool")

          yield { type: "text.delta", text: "Subagent internal note." }
          yield {
            type: "tool.call",
            callId: "call_sub_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain(
            "Inspect README.md and return only the final delegated summary.",
          )
          expect(requestText).toContain("Subagent internal note.")
          expect(requestText).toContain("This fixture exists for the read-only tool tests.")
          expect(requestText).not.toContain("Delegate README inspection through the agent tool")

          yield { type: "text.delta", text: "Delegated summary for parent." }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Delegate README inspection through the agent tool")
          expect(requestText).toContain("Delegated summary for parent.")
          expect(requestText).not.toContain("Subagent internal note.")
          expect(requestText).not.toContain("This fixture exists for the read-only tool tests.")

          yield { type: "text.delta", text: "Parent finished after delegated work." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const topLevelSessions = harness.repository.sessions.listTopLevel()
    const subSessions = harness.repository.sessions.listSubSessions(harness.session.id)

    expect(requests).toHaveLength(4)
    expect(topLevelSessions).toEqual([
      expect.objectContaining({ id: harness.session.id, parentSessionId: undefined }),
    ])
    expect(subSessions).toEqual([
      expect.objectContaining({ parentSessionId: harness.session.id }),
    ])

    const subSession = subSessions[0]!
    const subRuns = harness.repository.runs.listBySession(subSession.id)
    expect(subRuns).toHaveLength(1)

    const subRun = subRuns[0]!
    const parentTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const subTranscript = harness.repository.messages.listSessionTranscript(subSession.id)
    const parentText = readTranscriptText(parentTranscript).join("\n")
    const subText = readTranscriptText(subTranscript).join("\n")

    expect(parentTranscript).toHaveLength(3)
    expect([...new Set(parentTranscript.map((message) => message.runId))]).toEqual([started.run.id])
    expect(parentTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(parentTranscript[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(parentTranscript[1]?.parts[1]).toMatchObject({
      kind: "tool_result",
      text: "Delegated summary for parent.",
      data: {
        callId: "call_agent",
        toolName: "agent",
        output: "Delegated summary for parent.",
      },
    })
    expect(parentTranscript[2]?.parts).toMatchObject([
      { kind: "text", text: "Parent finished after delegated work." },
    ])
    expect(parentText).toContain("Delegate README inspection through the agent tool")
    expect(parentText).toContain("Delegated summary for parent.")
    expect(parentText).toContain("Parent finished after delegated work.")
    expect(parentText).not.toContain(
      "Inspect README.md and return only the final delegated summary.",
    )
    expect(parentText).not.toContain("Subagent internal note.")
    expect(parentText).not.toContain("This fixture exists for the read-only tool tests.")

    expect(subRun.parentRunId).toBe(started.run.id)
    expect(subTranscript).toHaveLength(3)
    expect([...new Set(subTranscript.map((message) => message.runId))]).toEqual([subRun.id])
    expect(subTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(subTranscript[1]?.parts.map((part) => part.kind)).toEqual(["text", "tool_call", "tool_result"])
    expect(subTranscript[1]?.parts[0]).toMatchObject({
      kind: "text",
      text: "Subagent internal note.",
    })
    expect(subTranscript[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: "1: # demo workspace\n2: \n3: This fixture exists for the read-only tool tests.",
      data: {
        callId: "call_sub_read",
        toolName: "read",
        output: "1: # demo workspace\n2: \n3: This fixture exists for the read-only tool tests.",
      },
    })
    expect(subTranscript[2]?.parts).toMatchObject([{ kind: "text", text: "Delegated summary for parent." }])
    expect(subText).toContain("Inspect README.md and return only the final delegated summary.")
    expect(subText).toContain("Subagent internal note.")
    expect(subText).toContain("This fixture exists for the read-only tool tests.")
    expect(subText).toContain("Delegated summary for parent.")
    expect(subText).not.toContain("Delegate README inspection through the agent tool")
    expect(subText).not.toContain("Parent finished after delegated work.")

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.call.completed",
        callId: "call_agent",
        name: "agent",
        output: "Delegated summary for parent.",
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
    expect(harness.repository.runs.get(subRun.id).status).toBe("completed")
  })

  test("keeps parent and subsession transcripts isolated in direct repository queries", async () => {
    const harness = await createHarness("subsession-isolation-repository", false)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_parent_repository",
      messageId: "message_parent_repository_user",
      prompt: "Parent asks for a delegated check",
    })

    const parentAssistant = harness.repository.createAssistantMessageWithFirstPart({
      message: {
        sessionId: harness.session.id,
        runId: started.run.id,
        sequence: 1,
        createdAt: harness.now(),
      },
      part: {
        kind: "text",
        sequence: 0,
        text: "Parent-only assistant note",
        createdAt: harness.now(),
      },
    })

    const created = harness.repository.createSubSessionWithRun({
      session: {
        id: "session_repository_child",
        parentSessionId: harness.session.id,
        directory: harness.workspaceRoot,
        workspaceRoot: harness.workspaceRoot,
        activeSkills: [],
        title: "Repository child session",
        latestUserMessagePreview: "Child-only delegated prompt",
        createdAt: harness.now(),
      },
      run: {
        id: "run_repository_child",
        trigger: "prompt",
        createdAt: harness.now(),
        activeSkills: [],
        parentRunId: started.run.id,
      },
      message: {
        id: "message_repository_child_user",
        sequence: 0,
        createdAt: harness.now(),
      },
      part: {
        id: "part_repository_child_user",
        kind: "text",
        sequence: 0,
        text: "Child-only delegated prompt",
        createdAt: harness.now(),
      },
    })

    const childAssistant = harness.repository.createAssistantMessageWithFirstPart({
      message: {
        sessionId: created.session.id,
        runId: created.run.id,
        sequence: 1,
        createdAt: harness.now(),
      },
      part: {
        kind: "text",
        sequence: 0,
        text: "Child-only internal note",
        createdAt: harness.now(),
      },
    })

    const topLevelSessions = harness.repository.sessions.listTopLevel()
    const subSessions = harness.repository.sessions.listSubSessions(harness.session.id)
    const parentTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const subTranscript = harness.repository.messages.listSessionTranscript(created.session.id)
    const parentText = readTranscriptText(parentTranscript).join("\n")
    const subText = readTranscriptText(subTranscript).join("\n")

    expect(topLevelSessions).toEqual([
      expect.objectContaining({ id: harness.session.id, parentSessionId: undefined }),
    ])
    expect(subSessions).toEqual([
      expect.objectContaining({ id: created.session.id, parentSessionId: harness.session.id }),
    ])
    expect(parentTranscript.map((message) => message.id)).toEqual([
      started.message.id,
      parentAssistant.message.id,
    ])
    expect(parentText).toContain("Parent asks for a delegated check")
    expect(parentText).toContain("Parent-only assistant note")
    expect(parentText).not.toContain("Child-only delegated prompt")
    expect(parentText).not.toContain("Child-only internal note")

    expect(subTranscript.map((message) => message.id)).toEqual([
      "message_repository_child_user",
      childAssistant.message.id,
    ])
    expect(subText).toContain("Child-only delegated prompt")
    expect(subText).toContain("Child-only internal note")
    expect(subText).not.toContain("Parent asks for a delegated check")
    expect(subText).not.toContain("Parent-only assistant note")
  })
})

async function createHarness(prefix: string, withFixtureWorkspace: boolean) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  if (withFixtureWorkspace) {
    await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })
  } else {
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, "placeholder.txt"), "placeholder")
  }

  const now = createMonotonicClock()
  const database = trackDatabase(openStorageDatabase(join(directory, "agent.sqlite")))
  const repository = createStorageRepository({
    database,
    now,
  })
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const service = createSessionRunService({
    repository,
    now,
  })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    repository,
    permissionRepository,
    service,
    session,
    workspaceRoot,
    now,
  }
}

function startPromptRun(input: {
  repository: StorageRepository
  permissionRepository: PermissionRepository
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
  const collected = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function readRequestText(request: ProviderTurnRequest) {
  return ((request.messages as Array<{ parts?: Array<Record<string, unknown>> }> | undefined) ?? []).flatMap(
    (message) =>
      (message.parts ?? []).flatMap((part) => {
        if (part.type === "text" && typeof part.text === "string") {
          return [part.text]
        }

        if (part.type === "tool_result" && typeof part.output === "string") {
          return [part.output]
        }

        return []
      }),
  )
}

function readTranscriptText(
  transcript: Array<{ parts: Array<{ kind: string; text: string | null }> }>,
) {
  return transcript.flatMap((message) =>
    message.parts.flatMap((part) =>
      (part.kind === "text" || part.kind === "tool_result") && typeof part.text === "string"
        ? [part.text]
        : [],
    ),
  )
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
