import type { ToolCatalogEntry, ToolDefinition } from "../domain"

export type ToolRegistryService = ReturnType<typeof createToolRegistryService>

export function createToolRegistryService(tools: ToolDefinition[]) {
  const byName = new Map<string, ToolDefinition>()

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`)
    }

    byName.set(tool.name, tool)
  }

  return {
    listTools(): ToolCatalogEntry[] {
      return [...byName.values()].map(({ 
        name, 
        description, 
        inputSchema,
        concurrency,
        isConcurrencySafe,
      }) => ({
        name,
        description,
        inputSchema,
        concurrency,
        isConcurrencySafe,
      }))
    },
    getTool(toolName: string) {
      return byName.get(toolName)
    },
  }
}
