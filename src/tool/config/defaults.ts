export {
  type RequestToolPermission,
  type ToolCatalogEntry,
  type ToolDefinition,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
} from "../types/tool"
export { type ToolExecutionInput, type ToolExecutionResult } from "../types/result"

export const SEARCH_SKIPPED_DIRECTORIES = new Set([".agents", ".git", "node_modules", ".worktrees"])
export const SEARCH_MAX_MATCHES = 20
export const SHELL_ABORT_GRACE_MS = 100
