import { describe, expect, test } from "bun:test"
import { mapTranscriptMessage } from "../../src/desktop/src/transcript-mapper"
import type { DesktopMessage } from "../../src/desktop/src/types"

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

    expect(mapTranscriptMessage(message)).toEqual({
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
})
