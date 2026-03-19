import type { StoredPermissionRequest } from "../permission"
import type { StoredMessage, StoredPart, StoredRun, StoredSession } from "../session"

export type SessionSnapshot = {
  session: StoredSession
  latestRun: StoredRun | null
  activeRun: StoredRun | null
  status: "idle" | "busy"
}

export type ServerEventPayload =
  | (SessionSnapshot & {
      type: "session.created" | "session.updated"
      reason?: string
    })
  | {
      type: "run.created" | "run.updated"
      run: StoredRun
    }
  | {
      type: "message.created"
      message: StoredMessage
    }
  | {
      type: "message.part.updated"
      part: StoredPart
    }
  | {
      type: "permission.requested"
      permissionRequest: StoredPermissionRequest
    }
  | {
      type: "permission.updated"
      permissionRequest: StoredPermissionRequest
    }
  | {
      type: "runtime.error"
      sessionId: string
      runId: string
      error: string
    }
  | {
      type: "heartbeat"
    }

export type ServerEvent = ServerEventPayload & {
  id: string
  time: number
}
