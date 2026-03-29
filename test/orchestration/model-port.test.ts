import { describe, expect, test } from "bun:test"
import { createFakeProvider, createModelProvider } from "../../src/model"
import type { OrchestrationModelPort } from "../../src/orchestration"

describe("orchestration model port", () => {
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
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(requests).toEqual([
      {
        system: expect.stringContaining("Skill catalog:"),
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "inspect README" }],
          },
        ],
        tools: [{ name: "read", description: "Read a file" }],
      },
    ])
  })
})
