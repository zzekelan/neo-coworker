import { describe, expect, test } from "bun:test"
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
  buildModelTurnProjection,
  type ModelProjectionInput,
  type ModelTranscriptMessage,
} from "../../src/model"
import {
  createEditTool,
  createReadTool,
  type ToolDefinition,
} from "../../src/tool"

function deriveCompressibleToolNames(tools: readonly ToolDefinition[]) {
  return new Set(tools.filter((tool) => tool.isCompressible).map((tool) => tool.name))
}

function makeTranscript(toolName: string, count: number): ModelTranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message_${toolName}_${index}`,
    sessionId: "session_1",
    runId: "run_1",
    role: "assistant" as const,
    sequence: index,
    createdAt: index + 1,
    parts: [
      {
        id: `part_${toolName}_${index}`,
        sessionId: "session_1",
        runId: "run_1",
        messageId: `message_${toolName}_${index}`,
        kind: "tool_result" as const,
        sequence: 0,
        text: `${toolName} result ${index}\n${"x".repeat(600)}`,
        data: {
          callId: `call_${toolName}_${index}`,
          toolName,
        },
        createdAt: index + 1,
      },
    ],
  }))
}

function makeInput(
  transcript: ModelTranscriptMessage[],
  compressibleToolNames: ReadonlySet<string>,
): ModelProjectionInput {
  return {
    systemPrompt: "You are a helpful assistant.",
    skillCatalog: [],
    activeSkills: [],
    contextWindow: 200,
    tools: [],
    transcript,
    compressibleToolNames,
  }
}

describe("integration: tool metadata drives compaction", () => {
  test("compresses older tool results when ToolDefinition.isCompressible is true", () => {
    const compressibleToolNames = deriveCompressibleToolNames([createReadTool()])
    const projection = buildModelTurnProjection(makeInput(makeTranscript("read", 7), compressibleToolNames))

    expect(compressibleToolNames.has("read")).toBe(true)
    expect(projection.microcompact).not.toBeNull()
    expect(projection.microcompact?.clearedCount).toBe(2)

    const outputs = projection.request.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.parts[0] as { output?: string }).output)

    expect(outputs.slice(0, 2)).toEqual([
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
      MICROCOMPACT_CLEARED_TOOL_RESULT_TEXT,
    ])
    expect(outputs.slice(-5)).toEqual(
      Array.from({ length: 5 }, (_, index) => expect.stringContaining(`read result ${index + 2}`)),
    )
  })

  test("retains tool results when ToolDefinition.isCompressible is false", () => {
    const requestPermission = async () => ({ decision: "allow" as const })
    const compressibleToolNames = deriveCompressibleToolNames([createEditTool({ requestPermission })])
    const projection = buildModelTurnProjection(makeInput(makeTranscript("edit", 7), compressibleToolNames))

    expect(compressibleToolNames.size).toBe(0)
    expect(projection.microcompact).toBeNull()

    const outputs = projection.request.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.parts[0] as { output?: string }).output)

    expect(outputs).toHaveLength(7)
    for (let index = 0; index < outputs.length; index += 1) {
      expect(outputs[index]).toContain(`edit result ${index}`)
    }
  })
})
