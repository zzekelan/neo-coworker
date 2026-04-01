import { describe, expect, test } from "bun:test"
import { buildModelPromptSections, buildModelTurnInput, buildTranscriptMessages } from "../../src/model"

describe("context builder", () => {
  test("injects explicit prompt sections for skills and transcript without duplicating tool descriptions", () => {
    const input = buildModelTurnInput({
      systemPrompt: "You are the agent runtime.",
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

    expect(input.system).toContain("You are the agent runtime.")
    expect(input.system).toContain("Skill catalog:")
    expect(input.system).toContain(".agents/skills/reviewer/SKILL.md")
    expect(input.system).toContain("Active skill instructions:")
    expect(input.system).toContain("## reviewer")
    expect(input.system).toContain("Always explain the diff.")
    expect(input.system).not.toContain("Available tools:")
    expect(input.system).not.toContain("- read: Read a file")
    expect(input.messages).toHaveLength(1)
  })

  test("renders empty skill sections explicitly when nothing is active", () => {
    const sections = buildModelPromptSections({
      systemPrompt: "You are the agent runtime.",
      skillCatalog: [],
      activeSkills: [],
      tools: [],
    })

    expect(sections.skillCatalogSection).toBe("Skill catalog:\n- None.")
    expect(sections.activeSkillSection).toBe("Active skill instructions:\n- None.")
  })

  test("keeps active skill instructions at the end of the system prompt", () => {
    const input = buildModelTurnInput({
      systemPrompt: "You are the agent runtime.",
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

    expect(input.system).toBe(
      [
        "You are the agent runtime.",
        "Skill catalog:\n- reviewer: Review carefully (.agents/skills/reviewer/SKILL.md)",
        "Active skill instructions:\n\n## reviewer\nFocus on bugs first.",
      ].join("\n\n"),
    )
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
})
