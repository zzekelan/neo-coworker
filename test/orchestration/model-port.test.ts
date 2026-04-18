import { describe, expect, test } from "bun:test"
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
  SYSTEM_REMINDER_NOTICE,
  createFakeProvider,
  createModelProvider,
} from "../../src/model"
import type { OrchestrationModelPort } from "../../src/orchestration"

describe("orchestration model port", () => {
  const basePrompt = "You are Neo Coworker, a versatile day-to-day work assistant."

  test("projects transcript and tools through the orchestration-facing port", async () => {
    const requests: Array<{
      system: string
      messages: unknown[]
      tools: unknown[]
    }> = []
    const model: OrchestrationModelPort = createModelProvider({
      runtime: createFakeProvider({
        onRequest(request) {
          requests.push({
            system: request.system,
            messages: request.messages,
            tools: request.tools,
          })
        },
      }),
    })

    const events = []
    for await (const event of model.streamTurn({
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
          runId: "run_1",
          role: "user",
          sequence: 0,
          parts: [{ kind: "text", text: "inspect README" }],
        },
      ],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "usage",
        source: "estimated",
        outputTokens: 0,
        inputTokens: expect.any(Number),
      }),
    ])
    expect(requests).toEqual([
      {
        system: [basePrompt, SYSTEM_REMINDER_NOTICE].join("\n\n"),
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "inspect README" }],
          },
          {
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
          },
        ],
        tools: [{ name: "read", description: "Read a file" }],
      },
    ])
  })

  test("passes orchestration temperature through to the provider-facing request", async () => {
    const requests: Array<{
      temperature?: number
    }> = []
    const model: OrchestrationModelPort = createModelProvider({
      runtime: createFakeProvider({
        onRequest(request) {
          requests.push({
            temperature: request.temperature,
          })
        },
      }),
    })

    for await (const _event of model.streamTurn({
      systemPrompt: basePrompt,
      skillCatalog: [],
      activeSkills: [],
      temperature: 0,
      tools: [],
      transcript: [
        {
          runId: "run_1",
          role: "user",
          sequence: 0,
          parts: [{ kind: "text", text: "inspect README" }],
        },
      ],
      signal: new AbortController().signal,
    })) {
      void _event
    }

    expect(requests).toEqual([{ temperature: 0 }])
  })

  test("microcompacts older compressible tool results and records telemetry", async () => {
    const requests: Array<{
      messages: Array<{
        role: string
        parts: Array<Record<string, unknown>>
      }>
      temperature?: number
    }> = []
    const observedEvents: unknown[] = []
    const model: OrchestrationModelPort = createModelProvider({
      observer: {
        recordModelEvent(event) {
          observedEvents.push(event)
        },
      },
      runtime: createFakeProvider({
        onRequest(request) {
          requests.push({
            messages: request.messages as Array<{
              role: string
              parts: Array<Record<string, unknown>>
            }>,
            temperature: request.temperature,
          })
        },
      }),
    })

    const transcript = Array.from({ length: 7 }, (_, index) => ({
      id: `message_${index}`,
      sessionId: "session_1",
      runId: "run_prior",
      role: "assistant" as const,
      sequence: index,
      createdAt: index + 1,
      parts: [
        {
          id: `part_${index}`,
          sessionId: "session_1",
          runId: "run_prior",
          messageId: `message_${index}`,
          kind: "tool_result",
          sequence: 0,
          text: `grep result ${index}\n${"x".repeat(600)}`,
          data: {
            callId: `call_${index}`,
            toolName: "grep",
          },
          createdAt: index + 1,
        },
      ],
    }))

    const events = []
    for await (const event of model.streamTurn({
      systemPrompt: basePrompt,
      skillCatalog: [],
      activeSkills: [],
      contextWindow: 200,
      temperature: 0,
      tools: [],
      transcript,
      sessionId: "session_1",
      runId: "run_microcompact",
      turnKey: "run_microcompact:turn_1",
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "usage",
        source: "estimated",
      }),
    ])
    expect(observedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "microcompact.applied",
          clearedCount: 2,
          retainedCount: 5,
          estimatedTokensSaved: expect.any(Number),
        }),
      ]),
    )

    const toolOutputs = requests[0]?.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.parts[0]?.output)

    expect(toolOutputs?.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
    expect(toolOutputs?.slice(-5)).toEqual(
      Array.from({ length: 5 }, (_, index) => expect.stringContaining(`grep result ${index + 2}`)),
    )
    expect(requests[0]?.temperature).toBe(0)
    expect(transcript[0]?.parts[0]?.text).toContain("grep result 0")
  })
})
