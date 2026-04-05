import { describe, expect, test } from "bun:test"

import type {
  ServerEvent,
  ServerEventPayload,
  StoredMessage,
  StoredPart,
  TranscriptMessage,
} from "../../src/bootstrap"
import { createCliChatRenderer } from "../../src/cli/chat-render"
import { createCliRenderState, renderServerEvent } from "../../src/cli/cli-render"
import type { CliIO } from "../../src/cli/cli-io"

describe("cli compaction surfaces", () => {
  test("stream render shows a compaction divider and hides the synthetic summary text", () => {
    const state = createCliRenderState()
    const message = createMessage({
      id: "message_compaction",
      role: "synthetic",
    })

    const output = [
      renderServerEvent(state, createEvent({ type: "message.created", message })),
      renderServerEvent(
        state,
        createEvent({
          type: "message.part.updated",
          part: createPart({
            id: "part_boundary",
            messageId: message.id,
            kind: "compaction_boundary",
            data: {
              tokensBefore: 12000,
              tokensAfter: 4200,
              compressionRatio: 0.65,
            },
          }),
        }),
      ),
      renderServerEvent(
        state,
        createEvent({
          type: "message.part.updated",
          part: createPart({
            id: "part_summary",
            messageId: message.id,
            kind: "text",
            text: "internal summary that should stay hidden",
          }),
        }),
      ),
    ].join("")

    expect(output).toContain("--- session compacted (12000 -> 4200 tokens, 65% saved) ---")
    expect(output).not.toContain("internal summary that should stay hidden")
  })

  test("chat hydration keeps compaction errors visible but hides the synthetic summary text", () => {
    const output: string[] = []
    const renderer = createCliChatRenderer({
      io: createIo(output),
      workspaceRoot: "/workspace",
    })

    renderer.hydrateTranscript({
      transcript: [
        createTranscriptMessage(
          {
            id: "message_user",
            role: "user",
            sequence: 0,
          },
          [
            createPart({
              id: "part_user",
              messageId: "message_user",
              kind: "text",
              text: "Please continue.",
            }),
          ],
        ),
        createTranscriptMessage(
          {
            id: "message_before",
            role: "assistant",
            sequence: 1,
          },
          [
            createPart({
              id: "part_before",
              messageId: "message_before",
              kind: "text",
              text: "Before compact.",
            }),
          ],
        ),
        createTranscriptMessage(
          {
            id: "message_compaction",
            role: "synthetic",
            sequence: 2,
          },
          [
            createPart({
              id: "part_boundary",
              messageId: "message_compaction",
              kind: "compaction_boundary",
              data: {
                tokensBefore: 15000,
                tokensAfter: 6000,
                compressionRatio: 0.6,
              },
            }),
            createPart({
              id: "part_summary",
              messageId: "message_compaction",
              kind: "text",
              text: "hidden internal compaction summary",
              sequence: 1,
            }),
          ],
        ),
        createTranscriptMessage(
          {
            id: "message_breaker",
            role: "synthetic",
            sequence: 3,
          },
          [
            createPart({
              id: "part_breaker",
              messageId: "message_breaker",
              kind: "error",
              text: "Automatic compaction is temporarily paused.",
            }),
          ],
        ),
        createTranscriptMessage(
          {
            id: "message_after",
            role: "assistant",
            sequence: 4,
          },
          [
            createPart({
              id: "part_after",
              messageId: "message_after",
              kind: "text",
              text: "After compact.",
            }),
          ],
        ),
      ],
    })

    const rendered = output.join("")
    expect(rendered).toContain("you> Please continue.")
    expect(rendered).toContain("assistant> Before compact.")
    expect(rendered).toContain("--- session compacted (15000 -> 6000 tokens, 60% saved) ---")
    expect(rendered).toContain("error> Automatic compaction is temporarily paused.")
    expect(rendered).toContain("assistant> After compact.")
    expect(rendered).not.toContain("hidden internal compaction summary")
  })

  test("chat live events render the compaction divider without exposing the synthetic summary text", () => {
    const output: string[] = []
    const renderer = createCliChatRenderer({
      io: createIo(output),
      workspaceRoot: "/workspace",
    })

    renderer.renderEvent(
      createEvent({
        type: "message.created",
        message: createMessage({
          id: "message_compaction",
          role: "synthetic",
        }),
      }),
    )
    renderer.renderEvent(
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_boundary",
          messageId: "message_compaction",
          kind: "compaction_boundary",
          data: {
            tokensBefore: 9000,
            tokensAfter: 3600,
            compressionRatio: 0.6,
          },
        }),
      }),
    )
    renderer.renderEvent(
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_summary",
          messageId: "message_compaction",
          kind: "text",
          text: "summary should be hidden",
        }),
      }),
    )
    renderer.renderEvent(
      createEvent({
        type: "message.created",
        message: createMessage({
          id: "message_failure",
          role: "synthetic",
          sequence: 1,
        }),
      }),
    )
    renderer.renderEvent(
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_failure",
          messageId: "message_failure",
          kind: "error",
          text: "Automatic compaction failed. Try again later.",
        }),
      }),
    )

    const rendered = output.join("")
    expect(rendered).toContain("--- session compacted (9000 -> 3600 tokens, 60% saved) ---")
    expect(rendered).toContain("error> Automatic compaction failed. Try again later.")
    expect(rendered).not.toContain("summary should be hidden")
  })
})

function createIo(output: string[]): CliIO {
  return {
    write(text) {
      output.push(text)
    },
    prompt() {
      return Promise.resolve("")
    },
  }
}

function createEvent(payload: ServerEventPayload): ServerEvent {
  return {
    ...payload,
    id: `event_${payload.type}_${Math.random().toString(16).slice(2)}`,
    time: 1,
  }
}

function createMessage(input: {
  id: string
  role: StoredMessage["role"]
  sequence?: number
}): StoredMessage {
  return {
    id: input.id,
    sessionId: "session_1",
    runId: "run_1",
    role: input.role,
    sequence: input.sequence ?? 0,
    createdAt: 1,
  }
}

function createTranscriptMessage(
  input: {
    id: string
    role: StoredMessage["role"]
    sequence: number
  },
  parts: StoredPart[],
): TranscriptMessage {
  return {
    ...createMessage(input),
    parts,
  }
}

function createPart(input: {
  id: string
  messageId: string
  kind: StoredPart["kind"]
  text?: string | null
  data?: unknown
  sequence?: number
}): StoredPart {
  return {
    id: input.id,
    sessionId: "session_1",
    runId: "run_1",
    messageId: input.messageId,
    kind: input.kind,
    sequence: input.sequence ?? 0,
    text: input.text ?? null,
    data: input.data ?? null,
    createdAt: 1,
  }
}
