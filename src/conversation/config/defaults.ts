export { MESSAGE_ROLES, type MessageRole, type StoredMessage, type TranscriptMessage } from "../types/message"
export { PART_KINDS, type PartKind, type StoredPart } from "../types/part"
export { RUN_STATUSES, RUN_TRIGGERS, type RunStatus, type RunTrigger, type StoredRun } from "../types/run"
export { type StoredSession } from "../types/session"

export const CURRENT_CONVERSATION_SCHEMA_VERSION = 2

export const PERMISSION_STATUSES = [
  "pending",
  "approved",
  "denied",
  "cancelled",
] as const

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number]

export const CONVERSATION_TABLES = [
  "session",
  "run",
  "message",
  "part",
  "permission_request",
] as const
