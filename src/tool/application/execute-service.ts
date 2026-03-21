import type { ToolExecutionInput } from "../domain"
import type { ToolRegistryService } from "./registry-service"

export type CreateToolExecutionServiceInput = {
  registry: ToolRegistryService
}

export function createToolExecutionService(input: CreateToolExecutionServiceInput) {
  return {
    async executeTool(value: ToolExecutionInput) {
      const tool = input.registry.getTool(value.toolName)
      if (!tool) {
        throw new Error(`Unknown tool: ${value.toolName}`)
      }

      return await tool.execute(value)
    },
  }
}
