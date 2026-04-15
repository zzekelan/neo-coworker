import {
  type CreateToolProviderScope,
  type ToolExecutionResult,
  type ToolObserverPort,
  createToolProviderFromRuntime,
  type ToolProvider,
  type ToolRuntimeApi,
} from "../application"
import {
  manageResultSize as manageResultSizeWithPorts,
  type ManageResultSizeOptions,
} from "../application/result-size-manager"
import {
  createResultStore,
} from "../infrastructure/result-store"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runtime/create-builtin-runtime"

export * from "../application"
export type { ManageResultSizeOptions } from "../application/result-size-manager"
export {
  DEFAULT_RESULT_STORE_TTL_MS,
  createResultStore,
} from "../infrastructure/result-store"
export type {
  CreateResultStoreInput,
  ResultStore,
  ResultStoreSaveResult,
} from "../infrastructure/result-store"
export {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runtime/create-builtin-runtime"
export { createCodesearchTool } from "../infrastructure/builtins/codesearch"
export { createEditTool } from "../infrastructure/builtins/edit"
export { createGlobTool } from "../infrastructure/builtins/glob"
export { createGrepTool } from "../infrastructure/builtins/grep"
export { createReadTool } from "../infrastructure/builtins/read"
export {
  createHttpSearchToolBackend,
  createPublicSearchToolBackend,
  type HttpSearchToolBackendConfig,
  type SearchToolBackend,
  type SearchToolBackendRequest,
  type SearchToolName,
} from "../infrastructure/builtins/search-backend"
export { createShellTool } from "../infrastructure/builtins/shell"
export { createWebfetchTool } from "../infrastructure/builtins/webfetch"
export { createWebsearchTool } from "../infrastructure/builtins/websearch"
export { createWriteTool } from "../infrastructure/builtins/write"

export function manageResultSize(
  result: ToolExecutionResult,
  input: number | ManageResultSizeOptions = 50_000,
) {
  if (typeof input === "number" || input.resultStore || !input.workspaceRoot) {
    return manageResultSizeWithPorts(result, input)
  }

  return manageResultSizeWithPorts(result, {
    ...input,
    resultStore: createResultStore({
      workspaceRoot: input.workspaceRoot,
      observer: input.observer,
      sessionId: input.sessionId,
      runId: input.runId,
    }),
  })
}

export function createToolProvider(input: {
  runtime?: ToolRuntimeApi
  requestPermission?: CreateBuiltinToolRuntimeInput["requestPermission"]
  observer?: ToolObserverPort
  scope?: CreateToolProviderScope
}): ToolProvider {
  const runtime =
    input.runtime ??
    createBuiltinToolRuntime({
      requestPermission: input.requestPermission,
    })

  return createToolProviderFromRuntime({
    runtime,
    observer: input.observer,
    scope: input.scope,
  })
}
