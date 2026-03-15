import { ConversationRepositoryError, type RequestPermissionAndPauseRunInput } from "./contract"

export function assertPendingPermissionRequestInput(
  input: RequestPermissionAndPauseRunInput["permissionRequest"],
) {
  const permissionRequest = input as Record<string, unknown>

  if ("status" in permissionRequest || "resolvedAt" in permissionRequest) {
    throw new ConversationRepositoryError(
      "requestPermissionAndPauseRun only creates pending unresolved permission requests",
    )
  }
}
