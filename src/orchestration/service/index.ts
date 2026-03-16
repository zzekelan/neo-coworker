import { z } from "zod"
import type { OrchestrationConversationPort } from "../ports/conversation"
import type { OrchestrationModelPort } from "../ports/model"
import type {
  OrchestrationPermissionMode,
  OrchestrationPermissionPort,
  OrchestrationPermissionResponse,
} from "../ports/permission"
import type { OrchestrationToolPort, OrchestrationToolPortFactory } from "../ports/tool"
import { createOrchestrationStepService } from "./step"

export const OrchestrationRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  trigger: z.enum(["cli"]),
  status: z.enum([
    "queued",
    "running",
    "waiting_permission",
    "completed",
    "failed",
    "cancelled",
  ]),
})

export const RunSchema = OrchestrationRunSchema

export type OrchestrationRun = z.infer<typeof OrchestrationRunSchema>
export type Run = OrchestrationRun

export type OrchestrationRuntimeEvent =
  | {
      type: "run.started"
      runId: string
    }
  | {
      type: "message.started"
      role: "assistant"
    }
  | {
      type: "message.delta"
      text: string
    }
  | {
      type: "permission.requested"
      requestId: string
      toolName: string
      reason: string
    }
  | {
      type: "tool.call.completed"
      callId: string
      name: string
      output: string
    }
  | {
      type: "run.completed"
      runId: string
    }
  | {
      type: "run.failed"
      runId: string
      error: string
    }
  | {
      type: "run.cancelled"
      runId: string
    }

export type RuntimeEvent = OrchestrationRuntimeEvent

export type OrchestrationRunHandle = {
  events: AsyncIterable<OrchestrationRuntimeEvent>
  cancel(): void | Promise<void>
  respondPermission(input: OrchestrationPermissionResponse): void | Promise<void>
}

export type RunHandle = OrchestrationRunHandle

export type OrchestrationEventEmitter = (event: OrchestrationRuntimeEvent) => void

export type OrchestrationResolvedPermissionPolicy = Record<
  string,
  OrchestrationPermissionMode
>

export type OrchestrationRunSuspension = {
  isPending(requestId: string): boolean
  requestPermission(input: {
    toolName: string
    reason: string
  }): Promise<OrchestrationPermissionResponse>
  respond(input: OrchestrationPermissionResponse): void
  cancel(error?: Error): void
}

export type OrchestrationActiveRunState = {
  storageIdentity: string
  sessionId: string
  runId: string
  controller: AbortController
  suspend: OrchestrationRunSuspension
  emit: OrchestrationEventEmitter
}

export type CreateOrchestrationRuntimeApiInput = {
  model: OrchestrationModelPort
  conversation: OrchestrationConversationPort
  permission: OrchestrationPermissionPort
  tools: OrchestrationToolPortFactory
  permissionPolicy?: Partial<Record<"write" | "edit" | "shell", OrchestrationPermissionMode>>
  systemPrompt?: string
  now?: () => number
}

export type OrchestrationRunInput = {
  sessionId: string
  runId: string
}

export type OrchestrationLoopInput = {
  sessionId: string
  runId: string
  signal: AbortSignal
  emit: OrchestrationEventEmitter
  tools: OrchestrationToolPort
  workspaceRoot: string
  systemPrompt: string
  stepService: ReturnType<typeof createOrchestrationStepService>
}

export { createOrchestrationStepService } from "./step"
