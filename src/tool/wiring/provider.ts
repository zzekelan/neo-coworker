import type { OrchestrationToolPort } from "../../orchestration/ports/tool"
import type { RequestToolPermission } from "../service"
import type { ToolRuntimeApi } from "../runtime/api"
import { createBuiltinToolRuntime } from "../runtime/runner"

export type ToolProvider = OrchestrationToolPort

export function createToolProvider(input: {
  runtime?: ToolRuntimeApi
  requestPermission?: RequestToolPermission
}): ToolProvider {
  const runtime =
    input.runtime ??
    createBuiltinToolRuntime({
      requestPermission: input.requestPermission,
    })

  return {
    list() {
      return runtime.list()
    },
    execute(value) {
      return runtime.execute(value)
    },
  }
}
