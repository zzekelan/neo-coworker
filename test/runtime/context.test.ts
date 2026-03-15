import { describe, expect, test } from "bun:test"
import { buildModelTurnInput, buildTranscriptMessages } from "../../src/model/service/projection"

describe("context builder", () => {
  test("injects system prompt, active skills, tool names, and transcript", () => {
    const input = buildModelTurnInput({
      systemPrompt: "You are the agent runtime.",
      activeSkillInstructions: ["Always explain the diff."],
      tools: [{ name: "read", description: "Read a file" }],
      transcript: [
        {
          role: "user",
          parts: [{ kind: "text", text: "inspect README" }],
        },
      ],
    })

    expect(input.system).toContain("You are the agent runtime.")
    expect(input.system).toContain("Always explain the diff.")
    expect(input.system).toContain("read")
    expect(input.messages).toHaveLength(1)
  })

  test("renders persisted tool calls, tool results, and errors back into model messages", () => {
    const messages = buildTranscriptMessages([
      {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 1,
        createdAt: 1,
        parts: [
          {
            id: "part_1",
            sessionId: "session_1",
            runId: "run_1",
            messageId: "message_1",
            kind: "tool_call",
            sequence: 0,
            text: null,
            data: {
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
            createdAt: 2,
          },
          {
            id: "part_2",
            sessionId: "session_1",
            runId: "run_1",
            messageId: "message_1",
            kind: "tool_result",
            sequence: 1,
            text: "file contents",
            data: {
              callId: "call_1",
              toolName: "read",
            },
            createdAt: 3,
          },
        ],
      },
      {
        id: "message_2",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 2,
        createdAt: 4,
        parts: [
          {
            id: "part_3",
            sessionId: "session_1",
            runId: "run_1",
            messageId: "message_2",
            kind: "error",
            sequence: 2,
            text: "tool failed",
            data: null,
            createdAt: 5,
          },
        ],
      },
    ])

    expect(messages).toEqual([
      {
        role: "assistant",
        parts: [
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
            output: "file contents",
          },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Error: tool failed" }],
      },
    ])
  })
})
