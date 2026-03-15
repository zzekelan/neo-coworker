import type { PermissionConversationPort } from "../ports/conversation"
import type { PermissionRepository } from "../repo"

export type CreatePermissionRequestServiceInput = {
  repository: PermissionRepository
  conversation: PermissionConversationPort
}

export function createPermissionRequestService(input: CreatePermissionRequestServiceInput) {
  const repository = input.repository
  const conversation = input.conversation

  return {
    requestPermission(inputValue: {
      runId: string
      permissionRequest: {
        id?: string
        toolName: string
        reason: string
        createdAt?: number
      }
    }) {
      const run = conversation.transitionRunToWaitingPermission(inputValue.runId)
      try {
        const permissionRequest = repository.requests.create({
          id: inputValue.permissionRequest.id,
          sessionId: run.sessionId,
          runId: run.id,
          toolName: inputValue.permissionRequest.toolName,
          reason: inputValue.permissionRequest.reason,
          createdAt: inputValue.permissionRequest.createdAt,
          status: "pending",
          resolvedAt: null,
        })

        return {
          run,
          permissionRequest,
        }
      } catch (error) {
        conversation.transitionRunToRunning(run.id)
        throw error
      }
    },
  }
}
