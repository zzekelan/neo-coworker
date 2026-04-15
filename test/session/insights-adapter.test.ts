import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionInsightsAdapter,
  createSessionRepository,
  openSessionDatabase,
  type SessionRepository,
} from "../../src/session"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("session insights adapter", () => {
  test("returns empty results for an empty database", async () => {
    const { adapter } = createTestSubject("empty-db")

    await expect(adapter.querySessions({})).resolves.toEqual([])
    await expect(adapter.getSessionInsight("session_missing")).resolves.toBeNull()
  })

  test("filters sessions by date range and sorts newest first", async () => {
    const { adapter, repository } = createTestSubject("date-range")

    repository.sessions.create({
      id: "session_old",
      directory: "/workspace/old",
      workspaceRoot: "/workspace",
      createdAt: Date.parse("2026-04-10T00:00:00.000Z"),
    })
    repository.sessions.create({
      id: "session_middle",
      directory: "/workspace/middle",
      workspaceRoot: "/workspace",
      createdAt: Date.parse("2026-04-12T00:00:00.000Z"),
    })
    repository.sessions.create({
      id: "session_newest",
      directory: "/workspace/newest",
      workspaceRoot: "/workspace",
      createdAt: Date.parse("2026-04-14T00:00:00.000Z"),
    })

    const insights = await adapter.querySessions({
      from: new Date("2026-04-11T00:00:00.000Z"),
      to: new Date("2026-04-14T12:00:00.000Z"),
    })

    expect(insights.map((insight) => insight.sessionId)).toEqual([
      "session_newest",
      "session_middle",
    ])
  })

  test("aggregates tool usage, turn counts, compaction counts, and stored token usage", async () => {
    const { adapter, database, repository } = createTestSubject("tool-usage")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace/session-1",
      workspaceRoot: "/workspace",
      createdAt: 100,
    })

    repository.runs.create({
      id: "run_prompt",
      sessionId: "session_1",
      trigger: "prompt",
      status: "completed",
      createdAt: 110,
      startedAt: 111,
      finishedAt: 180,
      inputTokens: 120,
      outputTokens: 30,
      tokenUsageSource: "provider",
    })
    repository.runs.create({
      id: "run_summarize",
      sessionId: "session_1",
      trigger: "summarize",
      status: "completed",
      createdAt: 181,
      startedAt: 182,
      finishedAt: 190,
      inputTokens: 20,
      outputTokens: 5,
      tokenUsageSource: "estimated",
    })

    const userMessage = repository.messages.create({
      id: "message_user",
      sessionId: "session_1",
      runId: "run_prompt",
      role: "user",
      sequence: 0,
      createdAt: 112,
    })
    repository.parts.create({
      id: "part_user_text",
      sessionId: "session_1",
      runId: "run_prompt",
      messageId: userMessage.id,
      kind: "text",
      sequence: 0,
      text: "inspect repo",
      createdAt: 113,
    })

    const assistantMessage = repository.messages.create({
      id: "message_assistant",
      sessionId: "session_1",
      runId: "run_prompt",
      role: "assistant",
      sequence: 1,
      createdAt: 120,
    })
    repository.parts.create({
      id: "part_tool_call_1",
      sessionId: "session_1",
      runId: "run_prompt",
      messageId: assistantMessage.id,
      kind: "tool_call",
      sequence: 0,
      text: "bash ls",
      data: { callId: "call_1", toolName: "bash", inputText: "ls" },
      createdAt: 121,
    })
    repository.parts.create({
      id: "part_tool_result_1",
      sessionId: "session_1",
      runId: "run_prompt",
      messageId: assistantMessage.id,
      kind: "tool_result",
      sequence: 1,
      text: "file-a",
      data: { callId: "call_1", toolName: "bash", output: "file-a" },
      createdAt: 122,
    })
    repository.parts.create({
      id: "part_tool_call_2",
      sessionId: "session_1",
      runId: "run_prompt",
      messageId: assistantMessage.id,
      kind: "tool_call",
      sequence: 2,
      text: "read src/index.ts",
      data: { callId: "call_2", toolName: "read", inputText: "src/index.ts" },
      createdAt: 123,
    })
    repository.parts.create({
      id: "part_tool_call_3",
      sessionId: "session_1",
      runId: "run_prompt",
      messageId: assistantMessage.id,
      kind: "tool_call",
      sequence: 3,
      text: "bash pwd",
      data: { callId: "call_3", toolName: "bash", inputText: "pwd" },
      createdAt: 124,
    })

    const syntheticMessage = repository.messages.create({
      id: "message_synthetic",
      sessionId: "session_1",
      runId: "run_prompt",
      role: "synthetic",
      sequence: 2,
      createdAt: 191,
    })
    database
      .query(
        `
          INSERT INTO part (
            id,
            session_id,
            run_id,
            message_id,
            kind,
            sequence,
            text_value,
            data_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "part_compaction_boundary",
        "session_1",
        "run_prompt",
        syntheticMessage.id,
        "compaction_boundary",
        0,
        null,
        JSON.stringify({ summarizeRunId: "run_summarize" }),
        191,
      )

    const insight = await adapter.getSessionInsight("session_1")

    expect(insight).toEqual({
      sessionId: "session_1",
      startedAt: new Date(100),
      endedAt: new Date(190),
      totalTokens: {
        input: 140,
        output: 35,
      },
      toolUsage: new Map([
        ["bash", 2],
        ["read", 1],
      ]),
      turnCount: 1,
      compactionCount: 1,
    })
  })

  test("falls back to char-per-token approximation only when stored token data is unavailable", async () => {
    const { adapter, repository } = createTestSubject("token-fallback")

    repository.sessions.create({
      id: "session_1",
      directory: "/workspace/session-1",
      workspaceRoot: "/workspace",
      createdAt: 100,
    })

    seedRunWithPrompt(repository, {
      sessionId: "session_1",
      runId: "run_provider",
      createdAt: 110,
      finishedAt: 120,
      inputTokens: 7,
      outputTokens: 11,
      tokenUsageSource: "provider",
      promptText: "0123456789abcdef",
      assistantText: "this text would approximate differently",
    })
    seedRunWithPrompt(repository, {
      sessionId: "session_1",
      runId: "run_unknown",
      createdAt: 130,
      finishedAt: 140,
      inputTokens: 0,
      outputTokens: 0,
      tokenUsageSource: null,
      promptText: "12345678",
      assistantText: "123456789",
    })

    const insight = await adapter.getSessionInsight("session_1")

    expect(insight?.totalTokens).toEqual({
      input: 9,
      output: 14,
    })
    expect(insight?.turnCount).toBe(2)
  })
})

function createTestSubject(prefix: string) {
  const database = openSessionDatabase(createDatabasePath(prefix))
  openDatabases.push(database)

  const repository = createSessionRepository({ database })
  const adapter = createSessionInsightsAdapter({ database })

  return {
    adapter,
    database,
    repository,
  }
}

function createDatabasePath(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `neo-coworker-${prefix}-`))
  tempDirectories.push(directory)
  return join(directory, "agent.sqlite")
}

function seedRunWithPrompt(
  repository: SessionRepository,
  input: {
    sessionId: string
    runId: string
    createdAt: number
    finishedAt: number
    inputTokens: number
    outputTokens: number
    tokenUsageSource: "provider" | "estimated" | null
    promptText: string
    assistantText: string
  },
) {
  repository.runs.create({
    id: input.runId,
    sessionId: input.sessionId,
    trigger: "prompt",
    status: "completed",
    createdAt: input.createdAt,
    startedAt: input.createdAt,
    finishedAt: input.finishedAt,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    tokenUsageSource: input.tokenUsageSource,
  })

  const userMessage = repository.messages.create({
    id: `${input.runId}_user_message`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "user",
    sequence: 0,
    createdAt: input.createdAt,
  })
  repository.parts.create({
    id: `${input.runId}_user_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: userMessage.id,
    kind: "text",
    sequence: 0,
    text: input.promptText,
    createdAt: input.createdAt,
  })

  const assistantMessage = repository.messages.create({
    id: `${input.runId}_assistant_message`,
    sessionId: input.sessionId,
    runId: input.runId,
    role: "assistant",
    sequence: 1,
    createdAt: input.createdAt + 1,
  })
  repository.parts.create({
    id: `${input.runId}_assistant_part`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "text",
    sequence: 0,
    text: input.assistantText,
    createdAt: input.createdAt + 1,
  })
}
