import {
  createToolExecutionService,
  createToolRegistryService,
  type ToolDefinition,
} from "../service"

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
