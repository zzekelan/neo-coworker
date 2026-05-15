export type DesktopWorkspaceSummary = {
  workspaceRoot: string
  name: string
  latestActivityAt: number
  sessionCount: number
  hasBusySession: boolean
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
  activeSkills: string[]
  currentAgent?: string
  latestRunStatus: RunStatus | null
}

export type DesktopSkillCatalogEntry = {
  name: string
  description: string
  path: string
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

export type MessageRole = "user" | "assistant" | "compaction"

export type PartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "step_start"
  | "step_finish"
  | "error"
  | "patch"
  | "compaction_boundary"

export type DesktopRun = {
  id: string
  sessionId: string
  trigger: RunTrigger
  status: RunStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  errorText: string | null
  activeSkills: string[]
  parentRunId: string | null
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

export type DesktopTimelinePart = Omit<DesktopPart, "runId" | "messageId"> & {
  producedByRunId: string
  entryId: string
}

export type DesktopTimelineEntry = Omit<DesktopMessage, "runId" | "sequence" | "parts"> & {
  producedByRunId: string
  runSequence: number
  timelineSequence: number
  agent?: string
  parts: DesktopTimelinePart[]
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

export type DesktopContextUsageSnapshot = {
  contextTokens: number
  contextWindow: number
  utilizationPercent: number
  source: "provider" | "estimated" | null
}

export type DesktopSessionSnapshot = {
  session: DesktopSessionSummary
  latestRun: DesktopRun | null
  activeRun: DesktopRun | null
  contextUsage: DesktopContextUsageSnapshot | null
  status: "idle" | "busy"
}

export type HeartbeatNotification = {
  id: string
  time: number
  type: "heartbeat"
}

export type SessionNotification = {
  id: string
  time: number
  type: "session.created" | "session.updated"
  session: DesktopSessionSummary
  latestRun: DesktopRun | null
  activeRun: DesktopRun | null
  status: "idle" | "busy"
  reason?: string
}

export type SessionDeletedNotification = {
  id: string
  time: number
  type: "session.deleted"
  sessionId: string
  workspaceRoot: string
}

export type RunNotification = {
  id: string
  time: number
  type: "run.created" | "run.updated"
  run: DesktopRun
}

export type TimelineEntryNotification = {
  id: string
  time: number
  type: "timeline.entry.created"
  entry: DesktopTimelineEntry
}

export type TimelinePartNotification = {
  id: string
  time: number
  type: "timeline.part.updated"
  part: DesktopTimelinePart
}

export type PermissionNotification = {
  id: string
  time: number
  type: "permission.requested" | "permission.updated"
  permissionRequest: DesktopPermissionRequest
}

export type RuntimeErrorNotification = {
  id: string
  time: number
  type: "runtime.error"
  sessionId: string
  runId: string
  error: string
}

export type ToolProgressNotification = {
  id: string
  time: number
  type: "tool.progress"
  toolCallId: string
  message: string
  timestamp: number
}

export type ContextUsageNotification = {
  id: string
  time: number
  type: "context.usage.updated"
  sessionId: string
  runId: string
  contextTokens: number
  contextWindow: number
  utilizationPercent: number
  source: "provider" | "estimated" | null
}

export type DesktopAppServerNotification =
  | HeartbeatNotification
  | SessionNotification
  | SessionDeletedNotification
  | RunNotification
  | TimelineEntryNotification
  | TimelinePartNotification
  | PermissionNotification
  | RuntimeErrorNotification
  | ContextUsageNotification
  | ToolProgressNotification

export type ConnectionState = "offline" | "connecting" | "online" | "error"

export type ConnectionStatus = {
  state: ConnectionState
  label: string
  detail: string
}
