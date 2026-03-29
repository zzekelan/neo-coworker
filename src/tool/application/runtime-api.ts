import {
  createToolExecutionService,
} from "./execute-service"
import { createToolRegistryService } from "./registry-service"
import type { ToolObserverPort } from "./ports/tool-observer"
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
export type CreateToolProviderScope = {
  sessionId: string
  runId: string
}

export type CreateToolProviderFromRuntimeInput = {
  runtime: ToolRuntimeApi
  observer?: ToolObserverPort
  scope?: CreateToolProviderScope
}

export function createToolProviderFromRuntime(
  input: CreateToolProviderFromRuntimeInput,
): ToolProvider {
  return {
    list() {
      if (input.scope) {
        try {
          input.observer?.recordToolEvent?.({
            type: "tool.listed",
            sessionId: input.scope.sessionId,
            runId: input.scope.runId,
          })
        } catch {
          // Observability must not alter tool listing behavior.
        }
      }
      return input.runtime.list()
    },
    execute(value) {
      if (input.scope) {
        try {
          input.observer?.recordToolEvent?.({
            type: "tool.executed",
            sessionId: input.scope.sessionId,
            runId: input.scope.runId,
            toolName: value.toolName,
          })
        } catch {
          // Observability must not alter tool execution behavior.
        }
      }
      return input.runtime.execute(value)
    },
  }
}
