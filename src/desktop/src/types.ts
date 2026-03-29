export type DesktopWorkspaceSummary = {
  workspaceRoot: string
  name: string
  latestActivityAt: number
  sessionCount: number
  sessions: DesktopSessionSummary[]
}

export type DesktopSessionSummary = {
  id: string
  directory: string
  workspaceRoot: string
  createdAt: number
  title: string
  updatedAt: number
  latestUserMessagePreview: string | null
}

export type RunTrigger =
  | "cli"
  | "prompt"
  | "command"
  | "shell"
  | "retry"
  | "summarize"
  | "init"

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"

export type MessageRole = "user" | "assistant" | "synthetic"

export type PartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "step_start"
  | "step_finish"
  | "error"
  | "patch"

export type DesktopRun = {
  id: string
  sessionId: string
  trigger: RunTrigger
  status: RunStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  errorText: string | null
}

export type DesktopMessage = {
  id: string
  sessionId: string
  runId: string
  role: MessageRole
  sequence: number
  createdAt: number
  parts: DesktopPart[]
}

export type DesktopPart = {
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

export type DesktopPermissionRequest = {
  id: string
  sessionId: string
  runId: string
  toolName: string
  reason: string
  status: "pending" | "approved" | "denied" | "cancelled"
  createdAt: number
  resolvedAt: number | null
}

export type DesktopSessionSnapshot = {
  session: DesktopSessionSummary
  latestRun: DesktopRun | null
  activeRun: DesktopRun | null
  status: "idle" | "busy"
}

export type HeartbeatEvent = {
  id: string
  time: number
  type: "heartbeat"
}

export type SessionEvent = {
  id: string
  time: number
  type: "session.created" | "session.updated"
  session: DesktopSessionSummary
  latestRun: DesktopRun | null
  activeRun: DesktopRun | null
  status: "idle" | "busy"
  reason?: string
}

export type RunEvent = {
  id: string
  time: number
  type: "run.created" | "run.updated"
  run: DesktopRun
}

export type MessageEvent = {
  id: string
  time: number
  type: "message.created"
  message: Omit<DesktopMessage, "parts">
}

export type PartEvent = {
  id: string
  time: number
  type: "message.part.updated"
  part: DesktopPart
}

export type PermissionEvent = {
  id: string
  time: number
  type: "permission.requested" | "permission.updated"
  permissionRequest: DesktopPermissionRequest
}

export type RuntimeErrorEvent = {
  id: string
  time: number
  type: "runtime.error"
  sessionId: string
  runId: string
  error: string
}

export type DesktopServerEvent =
  | HeartbeatEvent
  | SessionEvent
  | RunEvent
  | MessageEvent
  | PartEvent
  | PermissionEvent
  | RuntimeErrorEvent

export type ConnectionState = "offline" | "connecting" | "online" | "error"

export type ConnectionStatus = {
  state: ConnectionState
  label: string
  detail: string
}
