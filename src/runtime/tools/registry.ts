import type { ToolDefinition, ToolRegistry } from "./types"

export function createToolRegistry(tools: ToolDefinition[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  return {
    list() {
      return [...byName.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }))
    },
    async execute(input) {
      const tool = byName.get(input.toolName)
      if (!tool) {
        throw new Error(`Unknown tool: ${input.toolName}`)
      }

      return await tool.execute(input)
    },
  }
}
