export interface DesktopWorkspace {
  id: string
  name: string
  workspaceRoot: string
}

export interface DesktopSession {
  id: string
  title: string
  workspaceRoot: string
  sessionId: string
  updatedAt: string
}

export type DesktopRunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"

export interface DesktopRun {
  id: string
  sessionId: string
  status: DesktopRunStatus
  createdAt: string
}

export interface DesktopSessionSnapshot {
  session: { id: string }
  latestRun?: DesktopRun
  activeRun?: DesktopRun
  status: "idle" | "busy"
}

export type MessagePart =
  | { type: "text"; text: string }
  | {
      type: "tool_call"
      toolName: string
      toolInput: unknown
      callId: string
      status?: "pending" | "success" | "error"
    }
  | { type: "tool_result"; callId: string; result: unknown }

export interface DesktopTranscriptMessage {
  id: string
  role: "user" | "assistant" | "synthetic"
  content: string
  parts?: MessagePart[]
  createdAt: string
}

export interface DesktopPermissionRequest {
  id: string
  sessionId: string
  runId: string
  status: "pending" | "approved" | "denied" | "cancelled"
  toolName: string
  reason: string
  createdAt: string
  resolvedAt: string | null
}
