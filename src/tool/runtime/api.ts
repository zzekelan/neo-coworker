import {
  createToolExecutionService,
  createToolRegistryService,
  type ToolTelemetryPort,
  type ToolDefinition,
} from "../service"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "./runner"

export type CreateToolRuntimeApiInput = {
  tools: ToolDefinition[]
}

export function createToolRuntimeApi(input: CreateToolRuntimeApiInput) {
  const registry = createToolRegistryService(input.tools)
  const execution = createToolExecutionService({ registry })

  return {
    list() {
      return registry.listTools()
    },
    execute: execution.executeTool,
  }
}

export type ToolRuntimeApi = ReturnType<typeof createToolRuntimeApi>

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

export * from "../service"
export {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "./runner"
