import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
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
import {
  TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY,
  TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY,
} from "../../src/orchestration"
import { createRuntime } from "../../src/bootstrap"
import { formatAnchorLine } from "../../src/tool/infrastructure/builtins/hash-anchor"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const README_READ_OUTPUT = [
  "L1#f1469abc|# demo workspace",
  "L2#e3b0c442|",
  "L3#d806ab8e|This fixture exists for the read-only tool tests.",
].join("\n")

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
            output: README_READ_OUTPUT,
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
      text: README_READ_OUTPUT,
      data: {
        callId: "call_1",
        toolName: "read",
        output: README_READ_OUTPUT,
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
        contextWindow: 192_000,
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

  test("recovers when the main model emits an unknown tool name", async () => {
    const harness = await createHarness("main-unknown-tool-recovery", true)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_main_unknown_tool_recovery",
      messageId: "message_main_unknown_tool_recovery_user",
      prompt: "Inspect README.md after correcting an unavailable tool.",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell_cmd",
            name: "shell_cmd",
            inputText: '{"cmd":"ls"}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Tool 'shell_cmd' is not available.")
          expect(requestText).toContain("Allowed tools:")
          expect(requestText).toContain("read")
          expect(requestText).toContain("shell")

          yield {
            type: "tool.call",
            callId: "call_read_after_unknown",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Recovered with an allowed read tool." }
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
    const unknownResult = activeRunMessages
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.kind === "tool_result" &&
          (part.data as { callId?: string } | undefined)?.callId === "call_shell_cmd",
      )
    const unknownEvent = events.find(
      (event) => event.type === "tool.call.completed" && event.callId === "call_shell_cmd",
    )

    expect(requests).toHaveLength(3)
    expect(unknownResult).toMatchObject({
      kind: "tool_result",
      text: expect.stringContaining("Tool 'shell_cmd' is not available."),
      data: {
        callId: "call_shell_cmd",
        toolName: "shell_cmd",
        output: expect.stringContaining("Allowed tools:"),
        isError: true,
        errorCode: "UNKNOWN_TOOL",
        metadata: expect.objectContaining({
          [TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY]: true,
          [TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY]: expect.arrayContaining(["read", "shell"]),
        }),
      },
    })
    expect(unknownEvent).toMatchObject({
      type: "tool.call.completed",
      callId: "call_shell_cmd",
      name: "shell_cmd",
      isError: true,
      recoverable: true,
      attemptedTool: "shell_cmd",
      allowedTools: expect.arrayContaining(["read", "shell"]),
    })
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
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
            inputText: '{"pattern":"fixture"}',
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
          output: README_READ_OUTPUT,
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
            inputText: '{"pattern":"fixture"}',
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
          inputText: '{"pattern":"fixture"}',
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
          output: README_READ_OUTPUT,
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
      "text",
      "tool_call",
      "tool_result",
      "tool_result",
    ])
    expect(events.filter((event) => event.type === "tool.call.completed")).toHaveLength(2)
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("uses a read-produced hash anchor in a follow-up edit call inside the same run", async () => {
    const harness = await createHarness("hash-anchor-loop", false)
    const filePath = join(harness.workspaceRoot, "notes.txt")
    const expectedReadOutput = [
      formatAnchorLine(1, "alpha"),
      formatAnchorLine(2, "beta"),
      formatAnchorLine(3, "gamma"),
    ].join("\n")

    await Bun.write(filePath, "alpha\nbeta\ngamma\n")

    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_hash_anchor_loop",
      messageId: "message_hash_anchor_loop",
      prompt: "Read notes.txt and replace beta using the read anchor",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_anchor",
            name: "read",
            inputText: '{"path":"notes.txt"}',
          }
        },
        async function* (request) {
          const readOutput = readRequestText(request).find((text) => text === expectedReadOutput)
          const betaAnchor = readOutput?.split("\n")[1]

          expect(readOutput).toBe(expectedReadOutput)
          expect(betaAnchor).toBe(formatAnchorLine(2, "beta"))

          yield {
            type: "tool.call",
            callId: "call_edit_anchor",
            name: "edit",
            inputText: JSON.stringify({
              path: "notes.txt",
              operation: "replace",
              start: betaAnchor,
              content: "BETA",
            }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Anchor-only edit complete." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      permissionPolicy: {
        edit: "allow",
      },
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(3)
    expect(requests[1]?.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            callId: "call_read_anchor",
            toolName: "read",
            inputText: '{"path":"notes.txt"}',
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_read_anchor",
            toolName: "read",
            output: expectedReadOutput,
          },
        ],
      },
    ])
    expect(requests[2]?.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            callId: "call_edit_anchor",
            toolName: "edit",
            inputText: JSON.stringify({
              path: "notes.txt",
              operation: "replace",
              start: formatAnchorLine(2, "beta"),
              content: "BETA",
            }),
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_edit_anchor",
            toolName: "edit",
            output: `Applied replace to notes.txt at line 2. Preview: ${formatAnchorLine(2, "BETA")}`,
          },
        ],
      },
    ])
    expect(activeRunMessages).toHaveLength(4)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(activeRunMessages[2]?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(activeRunMessages[3]?.parts).toMatchObject([
      { kind: "text", text: "Anchor-only edit complete." },
    ])
    expect(events.filter((event) => event.type === "tool.call.completed")).toHaveLength(2)
    expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma\n")
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("auto compacts prior transcript into a synthetic boundary summary before continuing", async () => {
    const harness = await createHarness("auto-compact", true)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_auto_compact_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_auto_compact",
      messageId: "message_auto_compact",
      prompt: "Continue after the earlier shell work",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "text.delta",
            text: [
              "<analysis>drop me</analysis>",
              "Primary Request",
              "Keep working on the shell-heavy task.",
              "",
              "Key Concepts",
              "Use the compacted summary instead of the original tool output.",
              "",
              "Files & Code",
              "README.md",
              "",
              "Errors & Fixes",
              "None.",
              "",
              "Problem Solving",
              "Summarize and continue.",
              "",
              "User Messages",
              "Continue after the earlier shell work",
              "",
              "Pending Tasks",
              "Finish the answer.",
              "",
              "Current Work",
              "Preparing the next reply.",
              "",
              "Next Steps",
              "Answer the user.",
            ].join("\n")
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Compaction complete." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      contextWindow: 15_000,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const runs = harness.repository.runs.listBySession(harness.session.id)
    const summarizeRun = runs.find((run) => run.trigger === "summarize")
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)
    const boundaryMessage = activeRunMessages.find((message) =>
      message.parts.some((part) => hasPartKind(part, "compaction_boundary")),
    )

    expect(requests).toHaveLength(2)
    expect(readRequestText(requests[0]!).join("\n")).toContain(
      "Return plain text with exactly these nine section headings",
    )
    expect(readRequestText(requests[1]!).join("\n")).toContain("Primary Request")
    expect(readRequestText(requests[1]!).join("\n")).not.toContain("shell output")
    expect(summarizeRun).toMatchObject({
      status: "completed",
      trigger: "summarize",
      tokenUsageSource: "estimated",
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    })
    expect(boundaryMessage?.role).toBe("synthetic")
    expect(boundaryMessage?.parts.map((part) => part.kind)).toEqual(["compaction_boundary", "text"])
    expect(boundaryMessage?.parts[0]).toMatchObject({
      kind: "compaction_boundary",
      data: {
        summarizeRunId: summarizeRun?.id,
        tokensBefore: expect.any(Number),
        tokensAfter: expect.any(Number),
        compressionRatio: expect.any(Number),
        trigger: "auto",
      },
    })
    expect(boundaryMessage?.parts[1]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("Primary Request"),
    })
    expect(String(boundaryMessage?.parts[1]?.text ?? "")).not.toContain("<analysis>")
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("manual compaction runs as a command and trims the next prompt turn", async () => {
    const harness = await createHarness("manual-compact", true)
    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_manual_compact_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "text.delta",
            text: [
              "Primary Request",
              "Keep working on the shell-heavy task.",
              "",
              "Key Concepts",
              "Use the compacted summary instead of the original tool output.",
              "",
              "Files & Code",
              "README.md",
              "",
              "Errors & Fixes",
              "None.",
              "",
              "Problem Solving",
              "Summarize on demand, then continue.",
              "",
              "User Messages",
              "Continue after manual compaction",
              "",
              "Pending Tasks",
              "Finish the answer.",
              "",
              "Current Work",
              "Compacting before the next turn.",
              "",
              "Next Steps",
              "Answer the user.",
            ].join("\n"),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Manual compaction reply." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      contextWindow: 15_000,
      now: harness.now,
    })

    const compactRun = startCommandRun({
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_manual_compact",
    })
    const compactHandle = await runtime.compactSession({
      sessionId: harness.session.id,
      runId: compactRun.run.id,
    })
    const compactEvents = await collectEvents(compactHandle.events)
    const compactTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const compactBoundary = compactTranscript.find(
      (message) =>
        message.runId === compactRun.run.id &&
        message.parts.some((part) => hasPartKind(part, "compaction_boundary")),
    )

    expect(harness.repository.runs.get(compactRun.run.id)).toMatchObject({
      trigger: "command",
      status: "completed",
    })
    expect(compactEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "compaction.completed",
          trigger: "manual",
          summarizeRunId: expect.any(String),
        }),
        expect.objectContaining({
          type: "context.usage.updated",
          runId: compactRun.run.id,
          source: "estimated",
        }),
      ]),
    )
    expect(compactBoundary?.role).toBe("synthetic")
    expect(compactBoundary?.parts[0]).toMatchObject({
      kind: "compaction_boundary",
      data: {
        trigger: "manual",
        summarizeRunId: expect.any(String),
      },
    })

    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_after_manual_compact",
      messageId: "message_after_manual_compact",
      prompt: "Continue after manual compaction",
    })
    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    expect(requests).toHaveLength(2)
    expect(readRequestText(requests[0]!).join("\n")).toContain(
      "Return plain text with exactly these nine section headings",
    )
    expect(readRequestText(requests[1]!).join("\n")).toContain("Primary Request")
    expect(readRequestText(requests[1]!).join("\n")).toContain("Continue after manual compaction")
    expect(readRequestText(requests[1]!).join("\n")).not.toContain("shell output")
    expect(
      harness.repository.messages
        .listSessionTranscript(harness.session.id)
        .filter((message) => message.role === "user")
        .map((message) => message.parts[0]?.text),
    ).toEqual(["Previous shell-heavy work", "Continue after manual compaction"])
  })

  test("restores active skills and recent read files after auto compaction", async () => {
    const harness = await createHarness("auto-compact-recovery", true)
    const skillDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer")

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

    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_recovery",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Read completed before compaction." }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: [
              "Primary Request",
              "Continue after compaction with recovered context.",
              "",
              "Key Concepts",
              "Recovered reminders should restore important context.",
              "",
              "Files & Code",
              "README.md remains relevant after compaction.",
              "",
              "Errors & Fixes",
              "None.",
              "",
              "Problem Solving",
              "Compact first, then answer with the restored context.",
              "",
              "User Messages",
              "Continue after auto compaction",
              "",
              "Pending Tasks",
              "Finish the response.",
              "",
              "Current Work",
              "Resuming after compaction.",
              "",
              "Next Steps",
              "Answer the user.",
            ].join("\n"),
          }
        },
        async function* (request) {
          const reminderText = readMessageTexts(request.messages).join("\n\n")
          expect(reminderText).toContain("## reviewer")
          expect(reminderText).toContain("Focus on bugs first.")
          expect(reminderText).toContain("Recent file context:")
          expect(reminderText).toContain("### README.md")
          expect(reminderText).toContain("This fixture exists for the read-only tool tests.")

          yield { type: "text.delta", text: "Recovered context is back." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      contextWindow: 15_000,
      now: harness.now,
    })

    const readRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_auto_compact_recovery_read",
      messageId: "message_auto_compact_recovery_read",
      prompt: "Read README before compaction",
    })
    const readHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: readRun.run.id,
    })
    await collectEvents(readHandle.events)

    seedCompletedRunWithToolResults({
      repository: harness.repository,
      sessionId: harness.session.id,
      runId: "run_auto_compact_recovery_history",
      toolName: "shell",
      resultCount: 7,
      output: "shell output\n" + "x".repeat(4_000),
    })

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_auto_compact_recovery",
      messageId: "message_auto_compact_recovery",
      prompt: "Continue after auto compaction",
    })
    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)

    expect(requests).toHaveLength(4)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "compaction.completed",
          trigger: "auto",
          summarizeRunId: expect.any(String),
        }),
      ]),
    )
    expect(readRequestText(requests[3]!).join("\n")).not.toContain("shell output")
  })

  test("restores active skills and recent read files on the next prompt after manual compaction", async () => {
    const harness = await createHarness("manual-compact-recovery", true)
    const skillDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer")

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

    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_manual_recovery",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Read completed before manual compaction." }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: [
              "Primary Request",
              "Compact the session and resume later.",
              "",
              "Key Concepts",
              "Manual compaction should preserve the key context.",
              "",
              "Files & Code",
              "README.md remains relevant after manual compaction.",
              "",
              "Errors & Fixes",
              "None.",
              "",
              "Problem Solving",
              "Compact now and continue on the next prompt.",
              "",
              "User Messages",
              "Compact now",
              "",
              "Pending Tasks",
              "Answer the follow-up prompt.",
              "",
              "Current Work",
              "Compacting before the next prompt.",
              "",
              "Next Steps",
              "Resume after compaction.",
            ].join("\n"),
          }
        },
        async function* (request) {
          const reminderText = readMessageTexts(request.messages).join("\n\n")
          expect(reminderText).toContain("## reviewer")
          expect(reminderText).toContain("Focus on bugs first.")
          expect(reminderText).toContain("Recent file context:")
          expect(reminderText).toContain("### README.md")
          expect(reminderText).toContain("This fixture exists for the read-only tool tests.")

          yield { type: "text.delta", text: "Recovered after manual compaction." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      contextWindow: 15_000,
      now: harness.now,
    })

    const readRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_manual_compact_recovery_read",
      messageId: "message_manual_compact_recovery_read",
      prompt: "Read README before manual compaction",
    })
    const readHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: readRun.run.id,
    })
    await collectEvents(readHandle.events)

    const compactRun = startCommandRun({
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_manual_compact_recovery_compact",
    })
    const compactHandle = await runtime.compactSession({
      sessionId: harness.session.id,
      runId: compactRun.run.id,
    })
    await collectEvents(compactHandle.events)

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_manual_compact_recovery",
      messageId: "message_manual_compact_recovery",
      prompt: "Continue after manual compaction",
    })
    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    expect(requests).toHaveLength(4)
    expect(readRequestText(requests[3]!).join("\n")).toContain("Continue after manual compaction")
  })

  test("projects workspace skill catalog and run active skills into model turns", async () => {
    const harness = await createHarness("skill-context", false)
    const skillDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer")

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
    const reminderTexts = readMessageTexts(requests[0]?.messages ?? [])
    expect(reminderTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Skill catalog:"),
        expect.stringContaining("Active skill instructions:"),
      ]),
    )
    expect(reminderTexts.join("\n\n")).toContain("reviewer: Review code changes carefully")
    expect(reminderTexts.join("\n\n")).toContain("## reviewer")
    expect(reminderTexts.join("\n\n")).toContain("Focus on bugs first.")
  })

  test("activates a skill mid-run and injects it on the next model turn", async () => {
    const harness = await createHarness("skill-activation", false)
    const skillDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer")

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
          expect(reminderText).not.toContain("Skill catalog:")
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
    expect(harness.repository.sessions.get(harness.session.id).activeSkills).toEqual(["reviewer"])

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

  test("keeps activated skills available to later runs in the same session", async () => {
    const harness = await createHarness("skill-session-persistence", false)
    const skillDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer")

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

    const firstRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_skill_session_first",
      messageId: "message_skill_session_first",
      prompt: "Activate the reviewer skill first",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_skill_persist",
            name: "skill",
            inputText: '{"name":"reviewer"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Reviewer activated." }
        },
        async function* (request) {
          const reminderText = readMessageTexts(request.messages).join("\n\n")
          expect(reminderText).not.toContain("Skill catalog:")
          expect(reminderText).not.toContain("## reviewer")
          expect(reminderText).not.toContain(
            "Focus on bugs first.",
          )
          yield { type: "text.delta", text: "Reviewer still available." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const firstHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: firstRun.run.id,
    })
    await collectEvents(firstHandle.events)

    expect(harness.repository.sessions.get(harness.session.id).activeSkills).toEqual(["reviewer"])

    const secondRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_skill_session_second",
      messageId: "message_skill_session_second",
      prompt: "Keep reviewing",
    })
    const secondHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: secondRun.run.id,
    })
    await collectEvents(secondHandle.events)

    expect(harness.repository.runs.get(secondRun.run.id).activeSkills).toEqual(["reviewer"])
    expect(requests).toHaveLength(3)
  })

  test("lists available skills without activating one", async () => {
    const harness = await createHarness("skill-list", false)
    const reviewerDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer")
    const writerDirectory = join(harness.workspaceRoot, ".ncoworker", "skills", "writer")

    await mkdir(reviewerDirectory, { recursive: true })
    await mkdir(writerDirectory, { recursive: true })
    await Bun.write(
      join(reviewerDirectory, "SKILL.md"),
      [
        "name: reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    )
    await Bun.write(
      join(writerDirectory, "SKILL.md"),
      [
        "name: writer",
        "description: Draft concise summaries",
        "",
        "Write concise operator-facing summaries.",
      ].join("\n"),
    )

    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_skill_list",
      messageId: "message_skill_list",
      prompt: "Show me which skills exist",
    })
    const runtime = createRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_skill_list",
            name: "skill",
            inputText: '{"action":"list"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Listed available skills." }
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

    const toolCallPart = activeRunMessages[1]?.parts[0]
    const toolResultPart = activeRunMessages[1]?.parts[1]
    expect(toolCallPart).toMatchObject({
      kind: "tool_call",
      data: {
        callId: "call_skill_list",
        toolName: "skill",
      },
    })
    expect(toolResultPart).toMatchObject({
      kind: "tool_result",
      data: {
        callId: "call_skill_list",
        toolName: "skill",
      },
    })
    const skillListOutput =
      typeof toolResultPart?.text === "string"
        ? toolResultPart.text
        : typeof (toolResultPart?.data as { output?: unknown } | undefined)?.output === "string"
          ? ((toolResultPart?.data as { output?: string }).output ?? "")
          : ""
    expect(skillListOutput).toContain("Available skills:")
    expect(skillListOutput).toContain("reviewer: Review code changes carefully")
    expect(skillListOutput).toContain("writer: Draft concise summaries")
    expect(harness.repository.runs.get(started.run.id).activeSkills).toEqual([])
    expect(harness.repository.sessions.get(harness.session.id).activeSkills).toEqual([])
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
              path: ".ncoworker/skills/reviewer/SKILL.md",
            },
          ]
        },
        async loadSkill() {
          notifySkillLoadStarted()
          await skillLoadBlocked
          return {
            name: "reviewer",
            path: ".ncoworker/skills/reviewer/SKILL.md",
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

  test("persists malformed tool arguments as a Tool Result Error and continues the run", async () => {
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
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(activeRunMessages[1]?.parts[1]).toMatchObject({
      kind: "tool_result",
      text: expect.stringContaining("Malformed tool arguments for read"),
      data: {
        callId: "call_bad",
        toolName: "read",
        output: expect.stringContaining("Malformed tool arguments for read"),
        isError: true,
        errorCode: "MALFORMED_TOOL_ARGUMENTS",
      },
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
            inputText: JSON.stringify({
              path: join(harness.workspaceRoot, "notes.txt"),
              content: "hello",
            }),
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

  test("records approved sibling tool results before cancelling a multi-pending batch", async () => {
    const harness = await createHarness("permission-partial-denied-batch", false)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_partial_denied_batch",
      messageId: "message_permission_partial_denied_batch_user",
      prompt: "Fetch two notes and deny the first request after approving the second",
    })
    const requests: ProviderTurnRequest[] = []
    const firstUrl = "data:text/plain,Hello%20from%20the%20denied%20fetch."
    const secondUrl = "data:text/plain,Hello%20from%20the%20approved%20fetch."
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_webfetch_denied",
            name: "webfetch",
            inputText: `{"url":"${firstUrl}"}`,
          }
          yield {
            type: "tool.call",
            callId: "call_webfetch_approved",
            name: "webfetch",
            inputText: `{"url":"${secondUrl}"}`,
          }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
      permissionPolicy: {
        webfetch: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = []
    let firstPermissionRequestId: string | null = null
    let secondPermissionRequestId: string | null = null
    let approvedSecondRequest = false
    let deniedFirstRequest = false

    for await (const event of handle.events) {
      events.push(event)

      if (event.type !== "permission.requested") {
        continue
      }

      if (event.reason === `webfetch ${firstUrl}`) {
        firstPermissionRequestId = event.requestId
      }

      if (event.reason === `webfetch ${secondUrl}`) {
        secondPermissionRequestId = event.requestId
      }

      if (!approvedSecondRequest && secondPermissionRequestId) {
        approvedSecondRequest = true
        await handle.respondPermission({
          requestId: secondPermissionRequestId,
          decision: "allow",
        })
      }

      if (approvedSecondRequest && !deniedFirstRequest && firstPermissionRequestId) {
        deniedFirstRequest = true
        await handle.respondPermission({
          requestId: firstPermissionRequestId,
          decision: "deny",
        })
      }
    }

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)
    const completedEventIndex = events.findIndex((event) => event.type === "tool.call.completed")
    const cancelledEventIndex = events.findIndex((event) => event.type === "run.cancelled")

    expect(requests).toHaveLength(1)
    expect(firstPermissionRequestId).not.toBeNull()
    expect(secondPermissionRequestId).not.toBeNull()
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual([
      "tool_call",
      "tool_call",
      "error",
      "tool_result",
    ])
    expect(activeRunMessages[1]?.parts[2]).toMatchObject({
      kind: "error",
      text: "Tool webfetch failed: Permission denied",
      data: {
        source: "tool",
        callId: "call_webfetch_denied",
        toolName: "webfetch",
      },
    })
    expect(activeRunMessages[1]?.parts[3]).toMatchObject({
      kind: "tool_result",
      text: "Hello from the approved fetch.",
      data: {
        callId: "call_webfetch_approved",
        toolName: "webfetch",
        output: "Hello from the approved fetch.",
      },
    })
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toMatchObject([
      {
        id: firstPermissionRequestId,
        status: "denied",
      },
      {
        id: secondPermissionRequestId,
        status: "approved",
      },
    ])
    expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(2)
    expect(events.filter((event) => event.type === "tool.call.completed")).toEqual([
      expect.objectContaining({
        type: "tool.call.completed",
        callId: "call_webfetch_approved",
        name: "webfetch",
        output: "Hello from the approved fetch.",
      }),
    ])
    expect(completedEventIndex).toBeGreaterThan(-1)
    expect(cancelledEventIndex).toBeGreaterThan(completedEventIndex)
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("retries transient provider failures before completing the run", async () => {
    const harness = await createHarness("provider-retry", false)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
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
            throw createRetryableProviderError("provider exploded")
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
      permissionRepository: harness.permissionRepository,
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
          throw createRetryableProviderError("provider exploded")
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
  permissionRepository?: PermissionRepository
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

function startCommandRun(input: {
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
}) {
  return input.service.startCommandRun({
    sessionId: input.sessionId,
    runId: input.runId,
  })
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

function seedCompletedRunWithToolResults(input: {
  repository: StorageRepository
  sessionId: string
  runId: string
  toolName: string
  resultCount: number
  output: string
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
    text: "Previous shell-heavy work",
  })
  const assistantMessage = input.repository.messages.create({
    id: `${input.runId}_assistant`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 1,
  })

  for (let index = 0; index < input.resultCount; index += 1) {
    input.repository.parts.create({
      id: `${input.runId}_tool_result_${index}`,
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: assistantMessage.id,
      kind: "tool_result",
      sequence: index,
      text: `${input.output}\n#${index}`,
      data: {
        callId: `${input.runId}_call_${index}`,
        toolName: input.toolName,
      },
    })
  }
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

async function collectEvents<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
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

function readMessageTexts(
  messages: Array<{ parts?: Array<Record<string, unknown>> }>,
) {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    ),
  )
}

function hasPartKind(part: { kind?: unknown }, kind: string) {
  return String(part.kind) === kind
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}

function createRetryableProviderError(message: string) {
  const error = new Error(message) as Error & {
    classified?: {
      reason: string
      original: Error
      retryable: boolean
      shouldCompress: boolean
      shouldRotateCredential: boolean
      shouldFallback: boolean
    }
  }
  error.classified = {
    reason: "timeout",
    original: error,
    retryable: true,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
  }
  return error
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
