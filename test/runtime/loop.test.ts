import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
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
  SYSTEM_REMINDER_NOTICE,
  buildTranscriptMessages,
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
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

describe("agent loop", () => {
  test("reads prior transcript, roundtrips tool results, and completes the same run", async () => {
    const harness = await createHarness("single-roundtrip", true)
    seedCompletedRun({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_history",
      userText: "What happened before?",
      assistantText: "Earlier assistant context.",
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_active",
      messageId: "message_active_user",
      prompt: "Inspect README.md",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Looking at the file." }
          yield {
            type: "tool.call",
            callId: "call_1",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Summary complete." }
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
    const requestTexts = requests.map(readRequestText)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requestTexts[0]?.join("\n")).toContain("Earlier assistant context.")
    expect(requestTexts[0]?.join("\n")).toContain("Inspect README.md")
    expect(requests[1]?.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Looking at the file." },
          {
            type: "tool_call",
            callId: "call_1",
            toolName: "read",
            inputText: '{"path":"README.md"}',
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_1",
            toolName: "read",
            output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
          },
        ],
      },
    ])
    expect(activeRunMessages).toHaveLength(3)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(activeRunMessages[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
      data: {
        callId: "call_1",
        toolName: "read",
        output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
      },
    })
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Summary complete." }])
    expect(events.map((event) => event.type)).toContain("tool.call.completed")
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "context.usage.updated",
        sessionId: harness.session.id,
        runId: started.run.id,
        contextTokens: expect.any(Number),
        contextWindow: 128_000,
        utilizationPercent: expect.any(Number),
        source: "estimated",
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      status: "completed",
      tokenUsageSource: "estimated",
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    })
  })

  test("supports multiple model and tool cycles inside one durable run", async () => {
    const harness = await createHarness("multi-cycle", true)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_multi",
      messageId: "message_multi_user",
      prompt: "Inspect the fixture twice",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_search",
            name: "grep",
            inputText: '{"query":"fixture"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Two checks complete." }
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
    await collectEvents(handle.events)

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(3)
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      parts: [
        {
          type: "tool_result",
          callId: "call_read",
          toolName: "read",
          output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
        },
      ],
    })
    expect(readRequestText(requests[2]!).join("\n")).toContain("README.md")
    expect(readRequestText(requests[2]!).join("\n")).toContain(
      "This fixture exists for the read-only tool tests.",
    )
    expect(activeRunMessages).toHaveLength(4)
    expect(
      activeRunMessages.flatMap((message) => message.parts.filter((part) => part.kind === "tool_result")),
    ).toHaveLength(2)
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("reconstructs mixed text and multiple tool calls from one provider turn before the next turn", async () => {
    const harness = await createHarness("mixed-turn", true)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_mixed_turn",
      messageId: "message_mixed_turn_user",
      prompt: "Inspect README.md and search for fixture references",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Open README first." }
          yield {
            type: "tool.call",
            callId: "call_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
          yield { type: "text.delta", text: "Search for fixture next." }
          yield {
            type: "tool.call",
            callId: "call_search",
            name: "grep",
            inputText: '{"query":"fixture"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Mixed turn complete." }
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
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages.slice(-3)[0]).toEqual({
      role: "assistant",
      parts: [
        { type: "text", text: "Open README first." },
        {
          type: "tool_call",
          callId: "call_read",
          toolName: "read",
          inputText: '{"path":"README.md"}',
        },
        { type: "text", text: "Search for fixture next." },
        {
          type: "tool_call",
          callId: "call_search",
          toolName: "grep",
          inputText: '{"query":"fixture"}',
        },
      ],
    })
    expect(requests[1]?.messages.slice(-3)[1]).toEqual({
      role: "tool",
      parts: [
        {
          type: "tool_result",
          callId: "call_read",
          toolName: "read",
          output: "# demo workspace\n\nThis fixture exists for the read-only tool tests.\n",
        },
      ],
    })
    expect(requests[1]?.messages.slice(-3)[2]).toMatchObject({
      role: "tool",
      parts: [
        {
          type: "tool_result",
          callId: "call_search",
          toolName: "grep",
          output: expect.stringContaining(
            "README.md:3: This fixture exists for the read-only tool tests.",
          ),
        },
      ],
    })
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(events.filter((event) => event.type === "tool.call.completed")).toHaveLength(2)
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("projects workspace skill catalog and run active skills into model turns", async () => {
    const harness = await createHarness("skill-context", false)
    const skillDirectory = join(harness.workspaceRoot, ".agents", "skills", "reviewer")

    await mkdir(skillDirectory, { recursive: true })
    await Bun.write(
      join(skillDirectory, "SKILL.md"),
      [
        "name: reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    )

    harness.repository.sessions.update({
      sessionId: harness.session.id,
      activeSkills: ["reviewer"],
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_skill_context",
      messageId: "message_skill_context",
      prompt: "Review the current changes",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Reviewing now." }
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
    await collectEvents(handle.events)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.system).toContain(SYSTEM_REMINDER_NOTICE)
    expect(requests[0]?.system).not.toContain("Skill catalog:")
    const skillReminder = readMessageTexts(requests[0]?.messages ?? []).at(-1) ?? ""
    expect(skillReminder).toContain("Skill catalog:")
    expect(skillReminder).toContain("reviewer: Review code changes carefully")
    expect(skillReminder).toContain("Active skill instructions:")
    expect(skillReminder).toContain("## reviewer")
    expect(skillReminder).toContain("Focus on bugs first.")
  })

  test("activates a skill mid-run and injects it on the next model turn", async () => {
    const harness = await createHarness("skill-activation", false)
    const skillDirectory = join(harness.workspaceRoot, ".agents", "skills", "reviewer")

    await mkdir(skillDirectory, { recursive: true })
    await Bun.write(
      join(skillDirectory, "SKILL.md"),
      [
        "name: reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    )

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_skill_activation",
      messageId: "message_skill_activation",
      prompt: "Use the reviewer skill if helpful",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* (request) {
          expect(request.system).toContain(SYSTEM_REMINDER_NOTICE)
          expect(request.system).not.toContain("Skill catalog:")
          const reminderText = readMessageTexts(request.messages).at(-1) ?? ""
          expect(reminderText).toContain("Skill catalog:")
          expect(reminderText).toContain("reviewer: Review code changes carefully")
          expect(reminderText).not.toContain("Active skill instructions:")
          expect(request.tools.map((tool) => tool.name)).toContain("skill")

          yield {
            type: "tool.call",
            callId: "call_skill",
            name: "skill",
            inputText: '{"name":"reviewer"}',
          }
        },
        async function* (request) {
          expect(request.system).toContain(SYSTEM_REMINDER_NOTICE)
          const reminderText = readMessageTexts(request.messages).at(-1) ?? ""
          expect(reminderText).toContain("## reviewer")
          expect(reminderText).toContain("Focus on bugs first.")

          yield { type: "text.delta", text: "Reviewer skill is now active." }
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
    await collectEvents(handle.events)

    expect(requests).toHaveLength(2)
    expect(harness.repository.runs.get(started.run.id).activeSkills).toEqual(["reviewer"])

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_skill",
          toolName: "skill",
        },
      },
      {
        kind: "tool_result",
        text: "Activated skill reviewer",
        data: {
          callId: "call_skill",
          toolName: "skill",
          output: "Activated skill reviewer",
        },
      },
    ])
  })

  test("does not activate a skill after cancellation is requested during skill loading", async () => {
    const harness = await createHarness("skill-cancelled-activation", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_skill_cancelled_activation",
      messageId: "message_skill_cancelled_activation",
      prompt: "Try to activate the reviewer skill and then cancel",
    })
    let releaseSkillLoad!: () => void
    const skillLoadBlocked = new Promise<void>((resolve) => {
      releaseSkillLoad = resolve
    })
    let notifySkillLoadStarted!: () => void
    const skillLoadStarted = new Promise<void>((resolve) => {
      notifySkillLoadStarted = resolve
    })
    const runtime = createRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_skill_cancelled",
            name: "skill",
            inputText: '{"name":"reviewer"}',
          }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      skill: {
        async listCatalog() {
          return [
            {
              name: "reviewer",
              description: "Review code changes carefully",
              path: ".agents/skills/reviewer/SKILL.md",
            },
          ]
        },
        async loadSkill() {
          notifySkillLoadStarted()
          await skillLoadBlocked
          return {
            name: "reviewer",
            path: ".agents/skills/reviewer/SKILL.md",
            instructions: "Focus on bugs first.",
          }
        },
      },
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })

    await skillLoadStarted
    handle.cancel()
    releaseSkillLoad()

    await collectEvents(handle.events)

    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      status: "cancelled",
      activeSkills: [],
    })

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_skill_cancelled",
          toolName: "skill",
        },
      },
    ])
    expect(activeRunMessages[1]?.parts).toHaveLength(1)
  })

  test("persists malformed tool arguments as an error outcome and continues the run", async () => {
    const harness = await createHarness("tool-error", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_tool_error",
      messageId: "message_tool_error_user",
      prompt: "Try a bad tool call",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_bad",
            name: "read",
            inputText: '{"path":',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Recovered after bad args." }
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
    await collectEvents(handle.events)

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests[1]?.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            callId: "call_bad",
            toolName: "read",
            inputText: '{"path":',
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_bad",
            toolName: "read",
            output: expect.stringContaining("Malformed tool arguments for read"),
            isError: true,
          },
        ],
      },
    ])
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "error"])
    expect(activeRunMessages[1]?.parts[1]).toMatchObject({
      kind: "error",
      text: expect.stringContaining("Malformed tool arguments for read"),
    })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("cancels the run after permission denial and preserves the tool error", async () => {
    const harness = await createHarness("permission-denied", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_denied",
      messageId: "message_permission_denied_user",
      prompt: "Try to write notes.txt and recover",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Trying to write notes.txt." }
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Permission denial handled." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = []
    for await (const event of handle.events) {
      events.push(event)

      if (event.type === "permission.requested") {
        await handle.respondPermission({
          requestId: event.requestId,
          decision: "deny",
        })
      }
    }

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)
    const permissionRequests = harness.permissionRepository.requests.listByRun(started.run.id)

    expect(requests).toHaveLength(1)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["text", "tool_call", "error"])
    expect(activeRunMessages[1]?.parts[2]).toMatchObject({
      kind: "error",
      text: "Tool write failed: Permission denied",
      data: {
        source: "tool",
        callId: "call_write",
        toolName: "write",
      },
    })
    expect(permissionRequests).toMatchObject([
      {
        toolName: "write",
        status: "denied",
      },
    ])
    expect(events.map((event) => event.type)).toContain("permission.requested")
    expect(events.map((event) => event.type)).toContain("run.cancelled")
    expect(events.map((event) => event.type)).not.toContain("tool.call.completed")
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("retries transient provider failures before completing the run", async () => {
    const harness = await createHarness("provider-retry", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_provider_retry",
      messageId: "message_provider_retry_user",
      prompt: "Retry the provider request",
    })
    let attempts = 0
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          attempts += 1

          if (attempts < 3) {
            throw new Error("provider exploded")
          }

          yield { type: "text.delta", text: "Recovered after retry." }
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(attempts).toBe(3)
    expect(activeRunMessages[1]?.parts).toMatchObject([
      { kind: "text", text: "Recovered after retry." },
    ])
    expect(events.filter((event) => event.type === "model.turn.retrying")).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      status: "completed",
      errorText: null,
    })
  })

  test("persists provider failures after exhausting retries and marks the run failed", async () => {
    const harness = await createHarness("provider-failure", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_provider_failure",
      messageId: "message_provider_failure_user",
      prompt: "Trigger a provider error",
    })
    let attempts = 0
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          attempts += 1
          throw new Error("provider exploded")
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(attempts).toBe(3)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["error"])
    expect(activeRunMessages[1]?.parts[0]).toMatchObject({
      kind: "error",
      text: "provider exploded",
      data: { source: "provider" },
    })
    expect(events.filter((event) => event.type === "model.turn.retrying")).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      runId: started.run.id,
      error: "provider exploded",
    })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      status: "failed",
      errorText: "provider exploded",
    })
  })

  test("does not retry provider failures after partial output is already persisted", async () => {
    const harness = await createHarness("provider-partial-failure", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_provider_partial_failure",
      messageId: "message_provider_partial_failure_user",
      prompt: "Trigger a provider error after partial output",
    })
    let attempts = 0
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          attempts += 1
          yield { type: "text.delta", text: "Starting." }
          throw new Error("provider exploded")
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(attempts).toBe(1)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["text", "error"])
    expect(activeRunMessages[1]?.parts[0]).toMatchObject({
      kind: "text",
      text: "Starting.",
    })
    expect(activeRunMessages[1]?.parts[1]).toMatchObject({
      kind: "error",
      text: "provider exploded",
      data: { source: "provider" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      runId: started.run.id,
      error: "provider exploded",
    })
  })

  test("cancellation requested after run start still persists already-yielded output", async () => {
    const harness = await createHarness("cancelled-after-start", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_cancelled_after_start",
      messageId: "message_cancelled_after_start_user",
      prompt: "Start and then cancel immediately",
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn(request: { signal: AbortSignal }) {
          yield { type: "text.delta", text: "Still working." }
          await new Promise<void>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted")
                error.name = "AbortError"
                reject(error)
              },
              { once: true },
            )
          })
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const observedTypes: string[] = []

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        break
      }

      observedTypes.push(next.value.type)
      if (next.value.type === "run.started") {
        handle.cancel()
      }
    }

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(observedTypes).toContain("message.delta")
    expect(observedTypes.at(-1)).toBe("run.cancelled")
    expect(activeRunMessages[1]?.parts).toMatchObject([{ kind: "text", text: "Still working." }])
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("cancellation keeps persisted output intact and marks the run cancelled", async () => {
    const harness = await createHarness("cancelled", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_cancelled",
      messageId: "message_cancelled_user",
      prompt: "Start and then cancel",
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn(request: { signal: AbortSignal }) {
          yield { type: "text.delta", text: "Partial output." }
          await new Promise<void>((_, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted")
                error.name = "AbortError"
                reject(error)
              },
              { once: true },
            )
          })
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const observedTypes: string[] = []

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        break
      }

      observedTypes.push(next.value.type)
      if (next.value.type === "message.delta") {
        handle.cancel()
      }
    }

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(observedTypes.at(-1)).toBe("run.cancelled")
    expect(activeRunMessages[1]?.parts).toMatchObject([{ kind: "text", text: "Partial output." }])
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("cancellation does not wait for a provider that ignores abort", async () => {
    const harness = await createHarness("cancelled-stalled-provider", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_cancelled_stalled_provider",
      messageId: "message_cancelled_stalled_provider_user",
      prompt: "Start and then cancel the stalled provider",
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          yield { type: "text.delta", text: "Still working." }
          await new Promise<void>(() => {})
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const observedTypes: string[] = []

    while (true) {
      const next = await Promise.race([
        iterator.next(),
        Bun.sleep(500).then(() => {
          throw new Error("Timed out waiting for runtime events")
        }),
      ])
      if (next.done) {
        break
      }

      observedTypes.push(next.value.type)
      if (next.value.type === "message.delta") {
        handle.cancel()
      }
    }

    expect(observedTypes.at(-1)).toBe("run.cancelled")
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("reloads already persisted assistant output from storage while the run is still active", async () => {
    const harness = await createHarness("reload", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_reload",
      messageId: "message_reload_user",
      prompt: "Write partial output",
    })
    let releaseStream!: () => void
    const streamBlocked = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const runtime = createRuntime({
      provider: {
        async *streamTurn() {
          yield { type: "text.delta", text: "Already persisted." }
          await streamBlocked
        },
      },
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        throw new Error("expected partial output before the stream closed")
      }

      if (next.value.type === "message.delta") {
        const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
        const reconstructed = buildTranscriptMessages(transcript)
        expect(readMessageTexts(reconstructed)).toContain("Already persisted.")
        expect(harness.repository.runs.get(started.run.id).status).toBe("running")
        handle.cancel()
        releaseStream()
        break
      }
    }

    const remainingTypes: string[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        break
      }
      remainingTypes.push(next.value.type)
    }

    expect(remainingTypes.at(-1)).toBe("run.cancelled")
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
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")
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

function seedCompletedRun(input: {
  repository: StorageRepository
  sessionId: string
  runId: string
  userText: string
  assistantText: string
}) {
  input.repository.runs.create({
    id: input.runId,
    sessionId: input.sessionId,
    trigger: "prompt",
    status: "completed",
  })
  const userMessage = input.repository.messages.create({
    id: `${input.runId}_user`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "user",
    sequence: 0,
  })
  input.repository.parts.create({
    id: `${input.runId}_user_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: userMessage.id,
    kind: "text",
    sequence: 0,
    text: input.userText,
  })
  const assistantMessage = input.repository.messages.create({
    id: `${input.runId}_assistant`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 1,
  })
  input.repository.parts.create({
    id: `${input.runId}_assistant_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "text",
    sequence: 0,
    text: input.assistantText,
  })
}

function createTurnProvider(
  requests: ProviderTurnRequest[],
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
){
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

function readRequestContents(request: ProviderTurnRequest) {
  return readRequestText(request)
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

function readMessageTexts(
  messages: Array<{ parts?: Array<Record<string, unknown>> }>,
) {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
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
