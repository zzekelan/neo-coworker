import type { ToolTelemetryPort } from "./ports/telemetry"
import type { ToolRuntimeApi } from "./runtime/api"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "./runtime/runner"

export * from "./config/defaults"
export type { ToolTelemetryPort } from "./ports/telemetry"
export * from "./service"
export {
  createToolRuntimeApi,
  type CreateToolRuntimeApiInput,
  type ToolRuntimeApi,
} from "./runtime/api"
export {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "./runtime/runner"

export type ToolProvider = Pick<ToolRuntimeApi, "list" | "execute">

export function createToolProvider(input: {
  runtime?: ToolRuntimeApi
  requestPermission?: CreateBuiltinToolRuntimeInput["requestPermission"]
  telemetry?: ToolTelemetryPort
}): ToolProvider {
  const runtime =
    input.runtime ??
    createBuiltinToolRuntime({
      requestPermission: input.requestPermission,
    })

  return {
    list() {
      input.telemetry?.recordToolEvent?.("tool.listed")
      return runtime.list()
    },
    execute(value) {
      input.telemetry?.recordToolEvent?.("tool.executed", {
        toolName: value.toolName,
      })
      return runtime.execute(value)
    },
  }
}
