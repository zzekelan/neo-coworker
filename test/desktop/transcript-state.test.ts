import { describe, expect, test } from "bun:test"
import {
  normalizeTranscript,
  updateToolProgress,
  upsertTranscriptMessage,
} from "../../src/desktop/src/transcript-state"
import type { DesktopMessage, DesktopPart } from "../../src/desktop/src/types"

describe("desktop transcript state", () => {
  test("keeps the server transcript order across multiple runs", () => {
    const transcript = normalizeTranscript([
      createMessage({
        id: "message-user-1",
        role: "user",
        runId: "run-1",
        sequence: 0,
        createdAt: 10,
      }),
      createMessage({
        id: "message-assistant-1",
        role: "assistant",
        runId: "run-1",
        sequence: 1,
        createdAt: 20,
      }),
      createMessage({
        id: "message-user-2",
        role: "user",
        runId: "run-2",
        sequence: 0,
        createdAt: 30,
      }),
    ])

    expect(transcript.map((message) => message.id)).toEqual([
      "message-user-1",
      "message-assistant-1",
      "message-user-2",
    ])
  })

  test("appends a newly streamed assistant reply instead of regrouping by sequence", () => {
    const transcript = upsertTranscriptMessage(
      [
        createMessage({
          id: "message-user-1",
          role: "user",
          runId: "run-1",
          sequence: 0,
          createdAt: 10,
        }),
        createMessage({
          id: "message-assistant-1",
          role: "assistant",
          runId: "run-1",
          sequence: 1,
          createdAt: 20,
        }),
        createMessage({
          id: "message-user-2",
          role: "user",
          runId: "run-2",
          sequence: 0,
          createdAt: 30,
        }),
      ],
      createMessage({
        id: "message-assistant-2",
        role: "assistant",
        runId: "run-2",
        sequence: 1,
        createdAt: 40,
      }),
    )

    expect(transcript.map((message) => message.id)).toEqual([
      "message-user-1",
      "message-assistant-1",
      "message-user-2",
      "message-assistant-2",
    ])
  })

  test("preserves ordering when a synthetic compaction boundary message arrives mid-transcript", () => {
    const transcript = upsertTranscriptMessage(
      [
        createMessage({
          id: "message-user-1",
          role: "user",
          runId: "run-1",
          sequence: 0,
          createdAt: 10,
        }),
        createMessage({
          id: "message-assistant-1",
          role: "assistant",
          runId: "run-1",
          sequence: 1,
          createdAt: 20,
        }),
      ],
      createMessage({
        id: "message-synthetic-compaction",
        role: "synthetic",
        runId: "run-1",
        sequence: 2,
        createdAt: 25,
      }),
    )

    expect(transcript.map((message) => message.id)).toEqual([
      "message-user-1",
      "message-assistant-1",
      "message-synthetic-compaction",
    ])
  })

  test("updates progress for the matching tool call without type escapes", () => {
    const messages = [
      createMessage({
        id: "message-assistant-1",
        role: "assistant",
        runId: "run-1",
        sequence: 1,
        createdAt: 20,
        parts: [
          createPart({
            id: "part-tool-call-1",
            kind: "tool_call",
            sequence: 1,
            createdAt: 20,
            data: { callId: "call-1", toolName: "read" },
          }),
        ],
      }),
    ]

    const updated = updateToolProgress(messages, "call-1", "Reading file...")
    const part = updated[0]?.parts[0]

    expect(part?.data).toEqual({
      callId: "call-1",
      toolName: "read",
      progress: "Reading file...",
    })
  })
})

function createMessage(input: {
  id: string
  role: DesktopMessage["role"]
  runId: string
  sequence: number
  createdAt: number
  parts?: DesktopPart[]
}): DesktopMessage {
  return {
    id: input.id,
    sessionId: "session-1",
    runId: input.runId,
    role: input.role,
    sequence: input.sequence,
    createdAt: input.createdAt,
    parts: input.parts ?? [],
  }
}

function createPart(input: {
  id: string
  kind: DesktopPart["kind"]
  sequence: number
  createdAt: number
  data: unknown
}): DesktopPart {
  return {
    id: input.id,
    sessionId: "session-1",
    runId: "run-1",
    messageId: "message-assistant-1",
    kind: input.kind,
    sequence: input.sequence,
    text: null,
    data: input.data,
    createdAt: input.createdAt,
  }
}
