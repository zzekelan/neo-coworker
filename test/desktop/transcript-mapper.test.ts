import { describe, expect, test } from "bun:test"
import { mapTranscriptMessage } from "../../src/desktop/src/transcript-mapper"
import type { DesktopMessage, RunStatus } from "../../src/desktop/src/types"

describe("desktop transcript mapper", () => {
  test("renders text-only prompt messages through the plain content path", () => {
    const message: DesktopMessage = {
      id: "message-user-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "user",
      sequence: 0,
      createdAt: 1_710_000_000_000,
      parts: [
        {
          id: "part-user-1",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-user-1",
          kind: "text",
          sequence: 0,
          text: "Reply exactly once.",
          data: null,
          createdAt: 1_710_000_000_000,
        },
      ],
    }

    expect(mapTranscriptMessage(message)).toEqual({
      id: "message-user-1",
      role: "user",
      content: "Reply exactly once.",
      parts: undefined,
      createdAt: new Date(1_710_000_000_000).toISOString(),
      runId: "run-1",
    })
  })

  test("preserves structured tool parts and derives tool status from results", () => {
    const message: DesktopMessage = {
      id: "message-assistant-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "assistant",
      sequence: 1,
      createdAt: 1_710_000_000_500,
      parts: [
        {
          id: "part-call-1",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-assistant-1",
          kind: "tool_call",
          sequence: 0,
          text: null,
          data: { callId: "call-1", toolName: "read_file", path: "README.md" },
          createdAt: 1_710_000_000_500,
        },
        {
          id: "part-result-1",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-assistant-1",
          kind: "tool_result",
          sequence: 1,
          text: null,
          data: { callId: "call-1", output: "done" },
          createdAt: 1_710_000_000_700,
        },
      ],
    }

    expect(
      mapTranscriptMessage(message, {
        runStatusById: new Map<string, RunStatus>([["run-1", "completed"]]),
      }),
    ).toEqual({
      id: "message-assistant-1",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool_call",
          toolName: "read_file",
          toolInput: { callId: "call-1", toolName: "read_file", path: "README.md" },
          callId: "call-1",
          status: "success",
        },
        {
          type: "tool_result",
          callId: "call-1",
          result: { callId: "call-1", output: "done" },
        },
      ],
      createdAt: new Date(1_710_000_000_500).toISOString(),
      runId: "run-1",
    })
  })

  test("marks unresolved tool calls as cancelled when the run is already cancelled", () => {
    const message: DesktopMessage = {
      id: "message-assistant-2",
      sessionId: "session-1",
      runId: "run-2",
      role: "assistant",
      sequence: 1,
      createdAt: 1_710_000_001_000,
      parts: [
        {
          id: "part-call-2",
          sessionId: "session-1",
          runId: "run-2",
          messageId: "message-assistant-2",
          kind: "tool_call",
          sequence: 0,
          text: null,
          data: { callId: "call-2", toolName: "write", path: "notes.txt" },
          createdAt: 1_710_000_001_000,
        },
      ],
    }

    expect(
      mapTranscriptMessage(message, {
        runStatusById: new Map<string, RunStatus>([["run-2", "cancelled"]]),
      }),
    ).toEqual({
      id: "message-assistant-2",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool_call",
          toolName: "write",
          toolInput: { callId: "call-2", toolName: "write", path: "notes.txt" },
          callId: "call-2",
          status: "cancelled",
        },
      ],
      createdAt: new Date(1_710_000_001_000).toISOString(),
      runId: "run-2",
    })
  })

  test("renders tool-sourced errors as structured tool result cards", () => {
    const message: DesktopMessage = {
      id: "message-assistant-3",
      sessionId: "session-1",
      runId: "run-3",
      role: "assistant",
      sequence: 1,
      createdAt: 1_710_000_001_500,
      parts: [
        {
          id: "part-call-3",
          sessionId: "session-1",
          runId: "run-3",
          messageId: "message-assistant-3",
          kind: "tool_call",
          sequence: 0,
          text: null,
          data: { callId: "call-3", toolName: "shell", command: "git status" },
          createdAt: 1_710_000_001_500,
        },
        {
          id: "part-error-3",
          sessionId: "session-1",
          runId: "run-3",
          messageId: "message-assistant-3",
          kind: "error",
          sequence: 1,
          text: "permission denied",
          data: { source: "tool", callId: "call-3", toolName: "shell" },
          createdAt: 1_710_000_001_600,
        },
      ],
    }

    expect(mapTranscriptMessage(message)).toEqual({
      id: "message-assistant-3",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool_call",
          toolName: "shell",
          toolInput: { callId: "call-3", toolName: "shell", command: "git status" },
          callId: "call-3",
          status: "error",
        },
        {
          type: "tool_result",
          callId: "call-3",
          result: {
            source: "tool",
            callId: "call-3",
            toolName: "shell",
            output: "permission denied",
          },
          isError: true,
        },
      ],
      createdAt: new Date(1_710_000_001_500).toISOString(),
      runId: "run-3",
    })
  })

  test("maps a compaction_boundary part into a structured compaction divider", () => {
    const message: DesktopMessage = {
      id: "message-synthetic-1",
      sessionId: "session-1",
      runId: "run-1",
      role: "synthetic",
      sequence: 2,
      createdAt: 1_710_000_002_000,
      parts: [
        {
          id: "part-boundary-1",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-synthetic-1",
          kind: "compaction_boundary",
          sequence: 0,
          text: null,
          data: {
            tokensBefore: 80000,
            tokensAfter: 12000,
            compressionRatio: 0.85,
            summarizeRunId: "run_summarize_1",
            trigger: "auto",
          },
          createdAt: 1_710_000_002_000,
        },
        {
          id: "part-summary-text-1",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-synthetic-1",
          kind: "text",
          sequence: 1,
          text: "## Section 1: Summary\nThis is the internal model-recovery summary that should NOT be shown to users.",
          data: null,
          createdAt: 1_710_000_002_100,
        },
      ],
    }

    const result = mapTranscriptMessage(message)

    // The compaction boundary part should be present
    expect(result.parts).toBeDefined()
    const boundaryPart = result.parts!.find((p) => p.type === "compaction_boundary")
    expect(boundaryPart).toEqual({
      type: "compaction_boundary",
      tokensBefore: 80000,
      tokensAfter: 12000,
      compressionRatio: 0.85,
      trigger: "auto",
    })

    // The sibling summary text should be hidden
    const textParts = result.parts!.filter((p) => p.type === "text")
    expect(textParts).toHaveLength(0)

    // Content string should be empty (no text parts)
    expect(result.content).toBe("")
  })

  test("keeps compaction failure error parts visible in the transcript", () => {
    const message: DesktopMessage = {
      id: "message-synthetic-2",
      sessionId: "session-1",
      runId: "run-1",
      role: "synthetic",
      sequence: 3,
      createdAt: 1_710_000_003_000,
      parts: [
        {
          id: "part-error-compact",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-synthetic-2",
          kind: "error",
          sequence: 0,
          text: "Automatic compaction failed: model timeout",
          data: {
            source: "compaction",
            eventType: "compaction.failed",
            trigger: "auto",
            error: "model timeout",
            attemptCount: 1,
            summarizeRunId: "run_summarize_2",
          },
          createdAt: 1_710_000_003_000,
        },
      ],
    }

    const result = mapTranscriptMessage(message)
    expect(result.content).toContain("Error: Automatic compaction failed: model timeout")
  })

  test("keeps compaction circuit-breaker error visible in the transcript", () => {
    const message: DesktopMessage = {
      id: "message-synthetic-3",
      sessionId: "session-1",
      runId: "run-1",
      role: "synthetic",
      sequence: 4,
      createdAt: 1_710_000_004_000,
      parts: [
        {
          id: "part-breaker",
          sessionId: "session-1",
          runId: "run-1",
          messageId: "message-synthetic-3",
          kind: "error",
          sequence: 0,
          text: "⚠️ Automatic compaction has been paused. Run /compact successfully to re-enable it.",
          data: {
            source: "compaction",
            eventType: "compaction.circuit_breaker.triggered",
            consecutiveFailures: 3,
            lastError: "model timeout",
            resolution: "manual_compact",
          },
          createdAt: 1_710_000_004_000,
        },
      ],
    }

    const result = mapTranscriptMessage(message)
    expect(result.content).toContain("⚠️ Automatic compaction has been paused")
  })

  test("maps reasoning parts as structured reasoning entries instead of flattening into text", () => {
    const message: DesktopMessage = {
      id: "message-assistant-reasoning",
      sessionId: "session-1",
      runId: "run-r1",
      role: "assistant",
      sequence: 1,
      createdAt: 1_710_000_005_000,
      parts: [
        {
          id: "part-reasoning-1",
          sessionId: "session-1",
          runId: "run-r1",
          messageId: "message-assistant-reasoning",
          kind: "reasoning",
          sequence: 0,
          text: "Step 1: inspect the file. Step 2: plan the edit.",
          data: null,
          createdAt: 1_710_000_005_000,
        },
        {
          id: "part-text-1",
          sessionId: "session-1",
          runId: "run-r1",
          messageId: "message-assistant-reasoning",
          kind: "text",
          sequence: 1,
          text: "Here is the edited file.",
          data: null,
          createdAt: 1_710_000_005_100,
        },
      ],
    }

    const result = mapTranscriptMessage(message)
    expect(result.parts).toEqual([
      {
        type: "reasoning",
        text: "Step 1: inspect the file. Step 2: plan the edit.",
        durationMs: 100,
      },
      { type: "text", text: "Here is the edited file." },
    ])
    expect(result.content).toBe("Here is the edited file.")
  })

  test("derives a per-LLM-call reasoning duration from the next generated part", () => {
    const message: DesktopMessage = {
      id: "message-assistant-reasoning-tool",
      sessionId: "session-1",
      runId: "run-r3",
      role: "assistant",
      sequence: 1,
      createdAt: 1_710_000_007_000,
      parts: [
        {
          id: "part-reasoning-tool-1",
          sessionId: "session-1",
          runId: "run-r3",
          messageId: "message-assistant-reasoning-tool",
          kind: "reasoning",
          sequence: 0,
          text: "Need to fetch the page.",
          data: null,
          createdAt: 1_710_000_007_200,
        },
        {
          id: "part-tool-call-1",
          sessionId: "session-1",
          runId: "run-r3",
          messageId: "message-assistant-reasoning-tool",
          kind: "tool_call",
          sequence: 1,
          text: null,
          data: { callId: "call-fetch", toolName: "webfetch", url: "http://127.0.0.1:4173/" },
          createdAt: 1_710_000_009_500,
        },
      ],
    }

    const result = mapTranscriptMessage(message)
    expect(result.parts?.[0]).toEqual({
      type: "reasoning",
      text: "Need to fetch the page.",
      durationMs: 2500,
    })
  })

  test("preserves completed reasoning activity metadata for desktop summaries", () => {
    const message: DesktopMessage = {
      id: "message-assistant-reasoning-summary",
      sessionId: "session-1",
      runId: "run-r2",
      role: "assistant",
      sequence: 1,
      createdAt: 1_710_000_006_000,
      parts: [
        {
          id: "part-reasoning-summary-1",
          sessionId: "session-1",
          runId: "run-r2",
          messageId: "message-assistant-reasoning-summary",
          kind: "reasoning",
          sequence: 0,
          text: "Plan the next call.",
          data: { activityLabel: "LLM call", durationMs: 2400 },
          createdAt: 1_710_000_006_000,
        },
      ],
    }

    const result = mapTranscriptMessage(message)
    expect(result.parts).toEqual([
      {
        type: "reasoning",
        text: "Plan the next call.",
        activityLabel: "LLM call",
        durationMs: 2400,
      },
    ])
  })

})
