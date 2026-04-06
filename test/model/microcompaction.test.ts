import { describe, expect, test } from "bun:test"
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
  buildModelTurnProjection,
} from "../../src/model"
import type { ModelProjectionInput, ModelTranscriptMessage } from "../../src/model"

const baseSystemPrompt = "You are a helpful assistant."

function makeToolResultTranscript(
  toolName: string,
  count: number,
): ModelTranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message_${index}`,
    sessionId: "session_1",
    runId: "run_1",
    role: "assistant" as const,
    sequence: index,
    createdAt: index + 1,
    parts: [
      {
        id: `part_${index}`,
        sessionId: "session_1",
        runId: "run_1",
        messageId: `message_${index}`,
        kind: "tool_result" as const,
        sequence: 0,
        text: `${toolName} result ${index}\n${"x".repeat(600)}`,
        data: {
          callId: `call_${index}`,
          toolName,
        },
        createdAt: index + 1,
      },
    ],
  }))
}

function makeBaseInput(
  overrides: Partial<ModelProjectionInput> & {
    transcript: ModelTranscriptMessage[]
  },
): ModelProjectionInput {
  return {
    systemPrompt: baseSystemPrompt,
    skillCatalog: [],
    activeSkills: [],
    contextWindow: 200,
    tools: [],
    ...overrides,
  }
}

describe("microcompaction — isCompressible metadata", () => {
  test("clears tool results when compressibleToolNames marks them as compressible", () => {
    const transcript = makeToolResultTranscript("read", 7)
    const projection = buildModelTurnProjection(
      makeBaseInput({
        transcript,
        compressibleToolNames: new Set(["read"]),
      }),
    )

    expect(projection.microcompact).not.toBeNull()
    expect(projection.microcompact?.clearedCount).toBe(2)
    expect(projection.microcompact?.retainedCount).toBe(5)

    const toolOutputs = projection.request.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m.parts[0] as { output?: string })?.output)

    expect(toolOutputs.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
    expect(toolOutputs.slice(-5)).toEqual(
      Array.from({ length: 5 }, (_, i) => expect.stringContaining(`read result ${i + 2}`)),
    )
  })

  test("retains tool results for edit/write/shell when not in compressibleToolNames", () => {
    const transcript = makeToolResultTranscript("edit", 7)
    const projection = buildModelTurnProjection(
      makeBaseInput({
        transcript,
        compressibleToolNames: new Set(["read", "glob", "grep", "webfetch", "websearch", "codesearch"]),
      }),
    )

    expect(projection.microcompact).toBeNull()

    const toolOutputs = projection.request.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m.parts[0] as { output?: string })?.output)

    expect(toolOutputs).toHaveLength(7)
    for (let i = 0; i < 7; i++) {
      expect(toolOutputs[i]).toContain(`edit result ${i}`)
    }
  })

  test("clears codesearch results when compressibleToolNames includes codesearch", () => {
    const transcript = makeToolResultTranscript("codesearch", 7)
    const projection = buildModelTurnProjection(
      makeBaseInput({
        transcript,
        compressibleToolNames: new Set(["read", "glob", "grep", "webfetch", "websearch", "codesearch"]),
      }),
    )

    expect(projection.microcompact).not.toBeNull()
    expect(projection.microcompact?.clearedCount).toBe(2)

    const toolOutputs = projection.request.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m.parts[0] as { output?: string })?.output)

    expect(toolOutputs.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
    expect(toolOutputs.slice(-5)).toEqual(
      Array.from({ length: 5 }, (_, i) => expect.stringContaining(`codesearch result ${i + 2}`)),
    )
  })
})
