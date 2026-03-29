import {
  type CreateToolProviderScope,
  type ToolObserverPort,
  createToolProviderFromRuntime,
  type ToolProvider,
  type ToolRuntimeApi,
} from "../application"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runtime/create-builtin-runtime"

export * from "../application"
export {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runtime/create-builtin-runtime"
export { createEditTool } from "../infrastructure/builtins/edit"
export { createGlobTool } from "../infrastructure/builtins/glob"
export { createGrepTool } from "../infrastructure/builtins/grep"
export { createReadTool } from "../infrastructure/builtins/read"
export { createShellTool } from "../infrastructure/builtins/shell"
export { createWriteTool } from "../infrastructure/builtins/write"

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
