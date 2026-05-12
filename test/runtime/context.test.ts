import { describe, expect, test } from "bun:test"
import {
  SYSTEM_REMINDER_NOTICE,
  buildModelPromptSections,
  buildModelTurnInput,
  buildTimelineMessages,
  type ModelTimelineMessage,
} from "../../src/model"

type PersistedTimelineMessage = ModelTimelineMessage & {
  id: string
  sessionId: string
  runId: string
  sequence: number
  createdAt: number
}

type PersistedTimelineEntry = ModelTimelineMessage & {
  id: string
  sessionId: string
  producedByRunId: string
  runSequence: number
  timelineSequence: number
  createdAt: number
}

describe("context builder", () => {
  const basePrompt = "You are Neo Coworker, a versatile day-to-day work assistant."

  test("keeps the system prompt static and injects skill context through a system reminder message", () => {
    const input = buildModelTurnInput({
      systemPrompt: basePrompt,
      skillCatalog: [
        {
          name: "reviewer",
          description: "Review code changes carefully",
          path: ".ncoworker/skills/reviewer/SKILL.md",
        },
      ],
      activeSkills: [{ name: "reviewer", instructions: "Always explain the diff." }],
      tools: [{ name: "read", description: "Read a file" }],
      timeline: [
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
            "- reviewer: Review code changes carefully (.ncoworker/skills/reviewer/SKILL.md)",
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

  test("appends the system reminder after replayed timeline messages", () => {
    const input = buildModelTurnInput({
      systemPrompt: basePrompt,
      skillCatalog: [
        {
          name: "reviewer",
          description: "Review carefully",
          path: ".ncoworker/skills/reviewer/SKILL.md",
        },
      ],
      activeSkills: [{ name: "reviewer", instructions: "Focus on bugs first." }],
      tools: [{ name: "read", description: "Read a file" }],
      timeline: [],
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
              "- reviewer: Review carefully (.ncoworker/skills/reviewer/SKILL.md)",
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
    const timeline = [
      {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 1,
        createdAt: 1,
        parts: [
          {
            kind: "tool_call",
            text: null,
            data: {
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          },
          {
            kind: "tool_result",
            text: "file contents",
            data: {
              callId: "call_1",
              toolName: "read",
            },
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
            kind: "error",
            text: "tool failed",
            data: null,
          },
        ],
      },
    ] satisfies PersistedTimelineMessage[]

    const messages = buildTimelineMessages(timeline)

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

  test("projects canonical Tool Result Errors as tool messages", () => {
    const timeline = [
      {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 1,
        createdAt: 1,
        parts: [
          {
            kind: "tool_call",
            text: "{}",
            data: {
              callId: "call_1",
              toolName: "boom",
              inputText: "{}",
            },
          },
          {
            kind: "tool_result",
            text: "Tool boom failed: boom exploded",
            data: {
              callId: "call_1",
              toolName: "boom",
              output: "Tool boom failed: boom exploded",
              isError: true,
              errorCode: "TOOL_EXECUTION_FAILED",
            },
          },
        ],
      },
    ] satisfies PersistedTimelineMessage[]

    const messages = buildTimelineMessages(timeline)

    expect(messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            callId: "call_1",
            toolName: "boom",
            inputText: "{}",
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_1",
            toolName: "boom",
            output: "Tool boom failed: boom exploded",
            isError: true,
          },
        ],
      },
    ])
  })

  test("preserves reasoning parts when replaying assistant tool-call messages", () => {
    const timeline = [
      {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 1,
        createdAt: 1,
        parts: [
          {
            kind: "reasoning",
            text: "Need to inspect the README before calling read.",
            data: null,
          },
          {
            kind: "tool_call",
            text: null,
            data: {
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          },
          {
            kind: "tool_result",
            text: "README contents",
            data: {
              callId: "call_1",
              toolName: "read",
              output: "README contents",
            },
          },
        ],
      },
    ] satisfies PersistedTimelineMessage[]

    const messages = buildTimelineMessages(timeline)

    expect(messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Need to inspect the README before calling read.",
          },
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
            output: "README contents",
          },
        ],
      },
    ])
  })

  test("omits unresolved tool calls from replayed timeline messages", () => {
    const timeline = [
      {
        id: "message_1",
        sessionId: "session_1",
        runId: "run_1",
        role: "assistant",
        sequence: 1,
        createdAt: 1,
        parts: [
          {
            kind: "tool_call",
            text: null,
            data: {
              callId: "call_pending",
              toolName: "write",
              inputText: '{"path":"/tmp/hello.ts","content":"console.log(\\"hello\\")"}',
            },
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
            kind: "text",
            text: "Try again",
            data: null,
          },
        ],
      },
    ] satisfies PersistedTimelineMessage[]

    const messages = buildTimelineMessages(timeline)

    expect(messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Try again" }],
      },
    ])
  })

  test("resolves tool calls by Produced By Run provenance for timeline entries", () => {
    const timeline = [
      {
        id: "entry_1",
        sessionId: "session_1",
        producedByRunId: "run_1",
        role: "assistant",
        runSequence: 0,
        timelineSequence: 0,
        createdAt: 1,
        parts: [
          {
            kind: "tool_call",
            text: null,
            data: {
              callId: "call_reused",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          },
        ],
      },
      {
        id: "entry_2",
        sessionId: "session_1",
        producedByRunId: "run_2",
        role: "assistant",
        runSequence: 0,
        timelineSequence: 1,
        createdAt: 2,
        parts: [
          {
            kind: "tool_result",
            text: "run 2 result",
            data: {
              callId: "call_reused",
              toolName: "read",
              output: "run 2 result",
            },
          },
        ],
      },
    ] satisfies PersistedTimelineEntry[]

    const messages = buildTimelineMessages(timeline)

    expect(messages).toEqual([
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_reused",
            toolName: "read",
            output: "run 2 result",
          },
        ],
      },
    ])
  })

  test("projects legacy tool error parts from timeline entries during migration", () => {
    const timeline = [
      {
        id: "entry_1",
        sessionId: "session_1",
        producedByRunId: "run_1",
        role: "assistant",
        runSequence: 0,
        timelineSequence: 0,
        createdAt: 1,
        parts: [
          {
            kind: "tool_call",
            text: "{}",
            data: {
              callId: "call_legacy",
              toolName: "read",
              inputText: "{}",
            },
          },
          {
            kind: "error",
            text: "legacy tool failure",
            data: {
              source: "tool",
              callId: "call_legacy",
              toolName: "read",
            },
          },
        ],
      },
    ] satisfies PersistedTimelineEntry[]

    const messages = buildTimelineMessages(timeline)

    expect(messages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            callId: "call_legacy",
            toolName: "read",
            inputText: "{}",
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: "call_legacy",
            toolName: "read",
            output: "Error: legacy tool failure",
            isError: true,
          },
        ],
      },
    ])
  })

  test("replays only from the latest compaction boundary message", () => {
    const timeline = [
      {
        id: "message_old",
        sessionId: "session_1",
        runId: "run_old",
        role: "user",
        sequence: 0,
        createdAt: 1,
        parts: [
          {
            kind: "text",
            text: "Old context that should be dropped",
            data: null,
          },
        ],
      },
      {
        id: "message_boundary",
        sessionId: "session_1",
        runId: "run_active",
        role: "compaction",
        sequence: 1,
        createdAt: 3,
        parts: [
          {
            kind: "compaction_boundary",
            text: null,
            data: {
              summarizeRunId: "run_summary",
            },
          },
          {
            kind: "text",
            text: "Primary Request\nKeep moving forward.",
            data: null,
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
            kind: "text",
            text: "What changed after compaction?",
            data: null,
          },
        ],
      },
    ] satisfies PersistedTimelineMessage[]

    const messages = buildTimelineMessages(timeline)

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

  test("preserves reasoning replay after slicing from the latest compaction boundary", () => {
    const timeline = [
      {
        id: "message_old",
        sessionId: "session_1",
        runId: "run_old",
        role: "assistant",
        sequence: 0,
        createdAt: 1,
        parts: [
          {
            kind: "reasoning",
            text: "Old reasoning that should be dropped.",
            data: null,
          },
        ],
      },
      {
        id: "message_boundary",
        sessionId: "session_1",
        runId: "run_active",
        role: "compaction",
        sequence: 1,
        createdAt: 2,
        parts: [
          {
            kind: "compaction_boundary",
            text: null,
            data: {
              summarizeRunId: "run_summary",
            },
          },
          {
            kind: "text",
            text: "Summary after compaction.",
            data: null,
          },
        ],
      },
      {
        id: "message_new",
        sessionId: "session_1",
        runId: "run_active",
        role: "assistant",
        sequence: 2,
        createdAt: 3,
        parts: [
          {
            kind: "reasoning",
            text: "Need the README before using read.",
            data: null,
          },
          {
            kind: "tool_call",
            text: null,
            data: {
              callId: "call_1",
              toolName: "read",
              inputText: '{"path":"README.md"}',
            },
          },
          {
            kind: "tool_result",
            text: "README contents",
            data: {
              callId: "call_1",
              toolName: "read",
              output: "README contents",
            },
          },
        ],
      },
    ] satisfies PersistedTimelineMessage[]

    const messages = buildTimelineMessages(timeline)

    expect(messages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", text: "Summary after compaction." }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Need the README before using read.",
          },
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
            output: "README contents",
          },
        ],
      },
    ])
  })
})
