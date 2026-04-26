import { WORKSPACE_ALLOWED_NCOWORKER_SUBTREES } from "./defaults"

export {
  SEARCH_MAX_MATCHES,
  SEARCH_SKIPPED_DIRECTORIES,
  SHELL_ABORT_GRACE_MS,
  WORKSPACE_ALLOWED_NCOWORKER_SUBTREES,
  WORKSPACE_MAX_MATCHES,
  WORKSPACE_RESERVED_DIRECTORIES,
  WORKSPACE_SKIPPED_DIRECTORIES,
  type RequestToolPermission,
  type ToolCatalogEntry,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolExecutionResult,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
} from "./defaults"

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

export function assertWorkspacePathNotReserved(relativePath: string) {
  if (isWorkspacePathReserved(relativePath)) {
    throw new Error(`Path is reserved for agent runtime data: ${relativePath}`)
  }
}

export function isWorkspacePathReserved(relativePath: string) {
  const segments = normalizeWorkspacePathSegments(relativePath)

  const ncoworkerIndex = segments.indexOf(".ncoworker")
  if (ncoworkerIndex === -1) {
    return false
  }

  return !isAllowedRootNcoworkerSubtree(segments, ncoworkerIndex)
}

export function isWorkspacePathInAllowedNcoworkerSubtree(relativePath: string) {
  const segments = normalizeWorkspacePathSegments(relativePath)
  return isAllowedRootNcoworkerSubtree(segments, segments.indexOf(".ncoworker"))
}

function normalizeWorkspacePathSegments(relativePath: string) {
  const segments: string[] = []

  for (const segment of relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((entry) => entry.length > 0 && entry !== ".")) {
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop()
      continue
    }

    segments.push(segment)
  }

  return segments
}

function isAllowedRootNcoworkerSubtree(segments: string[], ncoworkerIndex: number) {
  return (
    ncoworkerIndex === 0 &&
    segments.length >= 2 &&
    WORKSPACE_ALLOWED_NCOWORKER_SUBTREES.has(segments[1] ?? "")
  )
}
