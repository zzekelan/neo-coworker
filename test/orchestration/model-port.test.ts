import { describe, expect, test } from "bun:test"
import {
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
          role: "user",
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
})
