export interface DesktopWorkspace {
  id: string
  name: string
  workspaceRoot: string
  hasBusySession: boolean
}

export interface DesktopSession {
  id: string
  title: string
  workspaceRoot: string
  sessionId: string
  createdAt: string
  updatedAt: string
  activeSkills: string[]
  currentAgent?: string
  latestRunStatus: DesktopRunStatus | null
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
  activeSkills: string[]
  parentRunId?: string
}

export interface DesktopSessionSnapshot {
  session: {
    id: string
    activeSkills: string[]
    currentAgent?: string
  }
  latestRun?: DesktopRun
  activeRun?: DesktopRun
  contextUsage?: DesktopContextUsage | null
  status: "idle" | "busy"
}

export interface DesktopSkillCatalogEntry {
  name: string
  description: string
  path: string
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call"
      toolName: string
      toolInput: unknown
      callId: string
      status?: "pending" | "success" | "error" | "cancelled"
      progress?: string
    }
  | { type: "tool_result"; callId: string; result: unknown; isError?: boolean }
  | {
      type: "compaction_boundary"
      tokensBefore: number
      tokensAfter: number
      compressionRatio: number
      trigger: string
    }

export interface DesktopTranscriptMessage {
  id: string
  role: "user" | "assistant" | "synthetic"
  content: string
  parts?: MessagePart[]
  createdAt: string
  runId?: string
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

export interface DesktopContextUsage {
  contextTokens: number
  contextWindow: number
  utilizationPercent: number
  source: "provider" | "estimated" | null
}

export interface DesktopPrimaryAgent {
  name: string
  description: string
}
