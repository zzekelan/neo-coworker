import type { OrchestrationToolPort } from "../../orchestration/ports/tool"
import type { ToolRuntimeApi } from "../runtime/api"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../runtime/runner"

export type ToolProvider = OrchestrationToolPort

export function createToolProvider(input: {
  runtime?: ToolRuntimeApi
  requestPermission?: CreateBuiltinToolRuntimeInput["requestPermission"]
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
