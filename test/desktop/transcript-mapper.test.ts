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
    })
  })
})
