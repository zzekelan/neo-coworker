import { describe, expect, test } from "bun:test"
import {
  SYSTEM_REMINDER_NOTICE,
  buildModelPromptSections,
  buildModelTurnInput,
  buildTranscriptMessages,
} from "../../src/model"

describe("context builder", () => {
  const basePrompt = "You are Neo Coworker, a versatile day-to-day work assistant."

  test("keeps the system prompt static and injects skill context through a system reminder message", () => {
    const input = buildModelTurnInput({
      systemPrompt: basePrompt,
      skillCatalog: [
        {
          name: "reviewer",
          description: "Review code changes carefully",
          path: ".agents/skills/reviewer/SKILL.md",
        },
      ],
      activeSkills: [{ name: "reviewer", instructions: "Always explain the diff." }],
      tools: [{ name: "read", description: "Read a file" }],
      transcript: [
        {
          role: "user",
          parts: [{ kind: "text", text: "inspect README" }],
        },
      ],
    })

    expect(input.system).toBe([basePrompt, SYSTEM_REMINDER_NOTICE].join("\n\n"))
    expect(input.system).not.toContain("Skill catalog:")
    expect(input.system).not.toContain("Active skill instructions:")
    expect(input.system).not.toContain("Available tools:")
    expect(input.system).not.toContain("- read: Read a file")
    expect(input.messages).toHaveLength(2)
    expect(input.messages[1]).toEqual({
      role: "user",
      parts: [
        {
          type: "text",
          text: [
            "<system-reminder>",
            "Skill catalog:",
            "- reviewer: Review code changes carefully (.agents/skills/reviewer/SKILL.md)",
            "",
            "Active skill instructions:",
            "",
            "## reviewer",
            "Always explain the diff.",
            "</system-reminder>",
          ].join("\n"),
        },
      ],
    })
  })

  test("omits the system reminder message when there are no skills to describe", () => {
    const sections = buildModelPromptSections({
      systemPrompt: basePrompt,
      skillCatalog: [],
      activeSkills: [],
    })

    expect(sections.systemReminderNotice).toBe(SYSTEM_REMINDER_NOTICE)
    expect(sections.systemReminderMessages).toEqual([])
  })

  test("appends the system reminder after replayed transcript messages", () => {
    const input = buildModelTurnInput({
      systemPrompt: basePrompt,
      skillCatalog: [
        {
          name: "reviewer",
          description: "Review carefully",
          path: ".agents/skills/reviewer/SKILL.md",
        },
      ],
      activeSkills: [{ name: "reviewer", instructions: "Focus on bugs first." }],
      tools: [{ name: "read", description: "Read a file" }],
      transcript: [],
    })

    expect(input.messages).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: [
              "<system-reminder>",
              "Skill catalog:",
              "- reviewer: Review carefully (.agents/skills/reviewer/SKILL.md)",
              "",
              "Active skill instructions:",
              "",
              "## reviewer",
              "Focus on bugs first.",
              "</system-reminder>",
            ].join("\n"),
          },
        ],
      },
    ])
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

  test("omits unresolved tool calls from replayed transcript messages", () => {
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
              callId: "call_pending",
              toolName: "write",
              inputText: '{"path":"hello.ts","content":"console.log(\\"hello\\")"}',
            },
            createdAt: 2,
          },
        ],
      },
      {
        id: "message_2",
        sessionId: "session_1",
        runId: "run_2",
        role: "user",
        sequence: 0,
        createdAt: 3,
        parts: [
          {
            id: "part_2",
            sessionId: "session_1",
            runId: "run_2",
            messageId: "message_2",
            kind: "text",
            sequence: 0,
            text: "Try again",
            data: null,
            createdAt: 4,
          },
        ],
      },
    ])

    expect(messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Try again" }],
      },
    ])
  })

  test("replays only from the latest compaction boundary message", () => {
    const messages = buildTranscriptMessages([
      {
        id: "message_old",
        sessionId: "session_1",
        runId: "run_old",
        role: "user",
        sequence: 0,
        createdAt: 1,
        parts: [
          {
            id: "part_old",
            sessionId: "session_1",
            runId: "run_old",
            messageId: "message_old",
            kind: "text",
            sequence: 0,
            text: "Old context that should be dropped",
            data: null,
            createdAt: 2,
          },
        ],
      },
      {
        id: "message_boundary",
        sessionId: "session_1",
        runId: "run_active",
        role: "synthetic",
        sequence: 1,
        createdAt: 3,
        parts: [
          {
            id: "part_boundary",
            sessionId: "session_1",
            runId: "run_active",
            messageId: "message_boundary",
            kind: "compaction_boundary",
            sequence: 0,
            text: null,
            data: {
              summarizeRunId: "run_summary",
            },
            createdAt: 4,
          },
          {
            id: "part_summary",
            sessionId: "session_1",
            runId: "run_active",
            messageId: "message_boundary",
            kind: "text",
            sequence: 1,
            text: "Primary Request\nKeep moving forward.",
            data: null,
            createdAt: 5,
          },
        ],
      },
      {
        id: "message_new",
        sessionId: "session_1",
        runId: "run_active",
        role: "user",
        sequence: 2,
        createdAt: 6,
        parts: [
          {
            id: "part_new",
            sessionId: "session_1",
            runId: "run_active",
            messageId: "message_new",
            kind: "text",
            sequence: 0,
            text: "What changed after compaction?",
            data: null,
            createdAt: 7,
          },
        ],
      },
    ])

    expect(messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", text: "Primary Request\nKeep moving forward." }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "What changed after compaction?" }],
      },
    ])
  })
})
