import type { StoredPart } from "./part"

export const MESSAGE_ROLES = ["user", "assistant", "synthetic"] as const

export type MessageRole = (typeof MESSAGE_ROLES)[number]

export type StoredMessage = {
  id: string
  sessionId: string
  runId: string
  role: MessageRole
  sequence: number
  createdAt: number
}

export type TranscriptMessage = StoredMessage & {
  parts: StoredPart[]
}
