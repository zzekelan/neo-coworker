import {
  createToolExecutionService,
} from "./execute-service"
import { createToolRegistryService } from "./registry-service"
import type { ToolTelemetryPort } from "./ports/telemetry"
import type { ToolDefinition } from "../domain"

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

export type CreateToolProviderFromRuntimeInput = {
  runtime: ToolRuntimeApi
  telemetry?: ToolTelemetryPort
}

export function createToolProviderFromRuntime(
  input: CreateToolProviderFromRuntimeInput,
): ToolProvider {
  return {
    list() {
      input.telemetry?.recordToolEvent?.("tool.listed")
      return input.runtime.list()
    },
    execute(value) {
      input.telemetry?.recordToolEvent?.("tool.executed", {
        toolName: value.toolName,
      })
      return input.runtime.execute(value)
    },
  }
}
