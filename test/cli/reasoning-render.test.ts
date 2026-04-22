import { describe, expect, test } from "bun:test"

import type {
  ServerEvent,
  ServerEventPayload,
  StoredMessage,
  StoredPart,
} from "../../src/bootstrap"
import { createCliRenderState, renderServerEvent } from "../../src/cli/cli-render"

describe("cli reasoning render", () => {
  test("emits a reasoning> prefix on the first delta and only the new suffix on subsequent deltas", () => {
    const state = createCliRenderState()
    const message = createMessage({ id: "message_assistant", role: "assistant" })

    const first = renderServerEvent(
      state,
      createEvent({ type: "message.created", message }),
    )
    const second = renderServerEvent(
      state,
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_reasoning",
          messageId: message.id,
          kind: "reasoning",
          text: "Let me think about it.",
        }),
      }),
    )
    const third = renderServerEvent(
      state,
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_reasoning",
          messageId: message.id,
          kind: "reasoning",
          text: "Let me think about it. Step 1.",
        }),
      }),
    )

    expect(first).toBe("message.started assistant\n")
    expect(second).toBe("reasoning> Let me think about it.")
    expect(third).toBe(" Step 1.")
  })

  test("does not break tool_call rendering when reasoning and tool calls interleave", () => {
    const state = createCliRenderState()
    const message = createMessage({ id: "message_assistant_2", role: "assistant" })

    renderServerEvent(state, createEvent({ type: "message.created", message }))
    renderServerEvent(
      state,
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_reasoning_a",
          messageId: message.id,
          kind: "reasoning",
          text: "Considering options.",
        }),
      }),
    )
    const toolOutput = renderServerEvent(
      state,
      createEvent({
        type: "message.part.updated",
        part: createPart({
          id: "part_call_a",
          messageId: message.id,
          kind: "tool_call",
          data: { toolName: "read", inputText: '{"path":"a.md"}' },
        }),
      }),
    )

    expect(toolOutput).toBe('tool.call read: {"path":"a.md"}\n')
  })
})

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
