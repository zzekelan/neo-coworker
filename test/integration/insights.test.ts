import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  createCliStorageComposition,
} from "../../src/bootstrap"
import {
  type SessionRepository,
} from "../../src/session"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("integration: cli insights command", () => {
  test("prints formatted session insights from local stored sessions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "cli-insights-"))
    tempDirectories.push(workspaceRoot)

    const storage = createCliStorageComposition({
      workspaceRoot,
    })

    try {
      seedRunWithPrompt(storage.repository, {
        sessionId: "session_alpha",
        runId: "run_alpha_1",
        createdAt: 100,
        finishedAt: 120,
        inputTokens: 120,
        outputTokens: 30,
        promptText: "Inspect the repo",
        assistantText: "Started inspection.",
        toolCalls: ["bash", "read"],
      })
      seedRunWithPrompt(storage.repository, {
        sessionId: "session_alpha",
        runId: "run_alpha_2",
        createdAt: 130,
        finishedAt: 140,
        inputTokens: 5,
        outputTokens: 5,
        promptText: "Inspect it again",
        assistantText: "Ran a second pass.",
        toolCalls: ["bash"],
      })
      seedRunWithPrompt(storage.repository, {
        sessionId: "session_beta",
        runId: "run_beta_1",
        createdAt: 200,
        finishedAt: 220,
        inputTokens: 12,
        outputTokens: 3,
        promptText: "Summarize session health",
        assistantText: "Healthy.",
        toolCalls: [],
      })
    } finally {
      storage.close()
    }

    const { exitCode, stdout, stderr } = await runCliProcess(workspaceRoot, ["insights"])

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Session insights")
    expect(stdout).toContain(
      "Sessions: 2 | Tokens (input/output/total): 137/38/175 | Avg turns/session: 1.5 | Top tools: bash×2, read×1",
    )
    expect(stdout).toContain("sessionId | tokens (input/output/total) | turns | top tools")
    expect(stdout).toContain("session_beta | 12/3/15 | 1 | none")
    expect(stdout).toContain("session_alpha | 125/35/160 | 2 | bash×2, read×1")
  })
})

function seedRunWithPrompt(
  repository: SessionRepository,
  input: {
    sessionId: string
    runId: string
    createdAt: number
    finishedAt: number
    inputTokens: number
    outputTokens: number
    promptText: string
    assistantText: string
    toolCalls: string[]
  },
) {
  ensureSession(repository, input.sessionId, input.createdAt)

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
    tokenUsageSource: "provider",
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
    id: `${input.runId}_assistant_text`,
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: assistantMessage.id,
    kind: "text",
    sequence: 0,
    text: input.assistantText,
    createdAt: input.createdAt + 1,
  })

  input.toolCalls.forEach((toolName, index) => {
    repository.parts.create({
      id: `${input.runId}_tool_call_${index}`,
      sessionId: input.sessionId,
      runId: input.runId,
      messageId: assistantMessage.id,
      kind: "tool_call",
      sequence: index + 1,
      text: `${toolName} call ${index + 1}`,
      data: {
        callId: `${input.runId}_call_${index}`,
        toolName,
        inputText: "{}",
      },
      createdAt: input.createdAt + 2 + index,
    })
  })
}

async function runCliProcess(cwd: string, argv: string[]) {
  const cliEntryPath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url))
  const child = spawn(process.execPath, [cliEntryPath, ...argv], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""

  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
  })

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => {
      resolveExit(code ?? 0)
    })
  })

  return {
    exitCode,
    stdout,
    stderr,
  }
}

function ensureSession(repository: SessionRepository, sessionId: string, createdAt: number) {
  if (repository.sessions.list().some((session) => session.id === sessionId)) {
    return
  }

  repository.sessions.create({
    id: sessionId,
    directory: `/workspace/${sessionId}`,
    workspaceRoot: "/workspace",
    createdAt,
  })
}
