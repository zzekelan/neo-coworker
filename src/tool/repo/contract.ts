import {
  SEARCH_MAX_MATCHES,
  SEARCH_SKIPPED_DIRECTORIES,
  SHELL_ABORT_GRACE_MS,
  type RequestToolPermission,
  type ToolCatalogEntry,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolExecutionResult,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
} from "../config/defaults"

export {
  SEARCH_MAX_MATCHES,
  SEARCH_SKIPPED_DIRECTORIES,
  SHELL_ABORT_GRACE_MS,
  type RequestToolPermission,
  type ToolCatalogEntry,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolExecutionResult,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
} from "../config/defaults"

export function createToolAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

export function throwIfToolAborted(signal: AbortSignal | undefined, message?: string) {
  if (signal?.aborted) {
    throw createToolAbortError(message)
  }
}
