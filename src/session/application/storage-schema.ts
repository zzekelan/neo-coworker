export const CURRENT_SESSION_SCHEMA_VERSION = 10

export const SESSION_TABLES = [
  "session",
  "run",
  "message",
  "part",
  "permission_request",
  "permission_allowlist",
] as const
