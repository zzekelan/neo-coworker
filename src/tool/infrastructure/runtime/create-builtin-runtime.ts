import type { RequestToolPermission, ToolDefinition } from "../../domain"
import { createToolRuntimeApi } from "../../application/runtime-api"
import { createCodesearchTool } from "../builtins/codesearch"
import { createDatetimeTool } from "../builtins/datetime"
import { createEditTool } from "../builtins/edit"
import { createGlobTool } from "../builtins/glob"
import { createGrepTool } from "../builtins/grep"
import { createReadTool } from "../builtins/read"
import { type SearchToolBackend } from "../builtins/search-backend"
import { createShellTool } from "../builtins/shell"
import { createWebfetchTool } from "../builtins/webfetch"
import { createWebsearchTool } from "../builtins/websearch"
import { createWriteTool } from "../builtins/write"

const denyPermission: RequestToolPermission = async () => ({ decision: "deny" })

export type CreateBuiltinToolRuntimeInput = {
  requestPermission?: RequestToolPermission
  searchBackend?: SearchToolBackend
  extraTools?: ToolDefinition[]
}

export function createBuiltinToolRuntime(input: CreateBuiltinToolRuntimeInput = {}) {
  const requestPermission = input.requestPermission ?? denyPermission

  function annotateDefaults(tool: ToolDefinition): ToolDefinition {
      if (
        tool.name === "read" ||
        tool.name === "glob" ||
        tool.name === "grep" ||
        tool.name === "get_current_datetime" ||
        tool.name === "webfetch" ||
        tool.name === "websearch" ||
        tool.name === "codesearch"
      ) {
      return {
        ...tool,
        concurrency: tool.concurrency ?? "read-only",
        isCompressible: tool.isCompressible ?? true,
      }
    }

    if (tool.name === "write" || tool.name === "edit" || tool.name === "shell") {
      return {
        ...tool,
        concurrency: tool.concurrency ?? "mutating",
        isCompressible: tool.isCompressible ?? false,
      }
    }

    return tool
  }

  return createToolRuntimeApi({
    tools: [
      annotateDefaults(createReadTool()),
      annotateDefaults(createGlobTool()),
      annotateDefaults(createGrepTool()),
      annotateDefaults(createWebfetchTool({ requestPermission })),
      annotateDefaults(createWebsearchTool({
        requestPermission,
        searchBackend: input.searchBackend,
      })),
      annotateDefaults(createCodesearchTool({
        requestPermission,
        searchBackend: input.searchBackend,
      })),
      annotateDefaults(createDatetimeTool()),
      annotateDefaults(createWriteTool({ requestPermission })),
      annotateDefaults(createEditTool({ requestPermission })),
      annotateDefaults(createShellTool({ requestPermission })),
      ...(input.extraTools ?? []),
    ],
  })
}
