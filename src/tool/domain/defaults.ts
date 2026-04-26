export {
  type RequestToolPermission,
  type ToolCatalogEntry,
  type ToolDefinition,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
} from "./tool"
export { type ToolExecutionInput, type ToolExecutionResult } from "./result"

export const WORKSPACE_SKIPPED_DIRECTORIES = new Set([
  ".ncoworker",
  ".git",
  "node_modules",
  ".worktrees",
])
export const WORKSPACE_RESERVED_DIRECTORIES = new Set([
  ".ncoworker",
])
export const WORKSPACE_ALLOWED_NCOWORKER_SUBTREES = new Set([
  "evals",
  "memory",
  "permissions",
  "research",
  "skills",
  "tool-results",
])
export const WORKSPACE_MAX_MATCHES = 20
export const SEARCH_SKIPPED_DIRECTORIES = WORKSPACE_SKIPPED_DIRECTORIES
export const SEARCH_MAX_MATCHES = WORKSPACE_MAX_MATCHES
export const SHELL_ABORT_GRACE_MS = 100
