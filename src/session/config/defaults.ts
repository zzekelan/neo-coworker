export { MESSAGE_ROLES, type MessageRole, type StoredMessage, type TranscriptMessage } from "../types/message"
export { PART_KINDS, type PartKind, type StoredPart } from "../types/part"
export { RUN_STATUSES, RUN_TRIGGERS, type RunStatus, type RunTrigger, type StoredRun } from "../types/run"
export { type StoredSession } from "../types/session"

export const CURRENT_SESSION_SCHEMA_VERSION = 2

export const SESSION_TABLES = [
  "session",
  "run",
  "message",
  "part",
  "permission_request",
] as const
