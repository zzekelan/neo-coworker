export const PART_KINDS = [
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "step_start",
  "step_finish",
  "error",
  "patch",
  "compaction_boundary",
] as const

export type PartKind = (typeof PART_KINDS)[number]

export type StoredPart = {
  id: string
  sessionId: string
  runId: string
  messageId: string
  kind: PartKind
  sequence: number
  text: string | null
  data: unknown
  createdAt: number
}
