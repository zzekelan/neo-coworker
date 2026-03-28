import { describe, expect, test } from "bun:test"
import {
  normalizeTranscript,
  upsertTranscriptMessage,
} from "../../src/desktop/src/transcript-state"
import type { DesktopMessage } from "../../src/desktop/src/types"

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
})

function createMessage(input: {
  id: string
  role: DesktopMessage["role"]
  runId: string
  sequence: number
  createdAt: number
}): DesktopMessage {
  return {
    id: input.id,
    sessionId: "session-1",
    runId: input.runId,
    role: input.role,
    sequence: input.sequence,
    createdAt: input.createdAt,
    parts: [],
  }
}
