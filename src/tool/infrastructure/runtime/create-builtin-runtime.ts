import type { RequestToolPermission, ToolDefinition } from "../../domain"
import { createToolRuntimeApi } from "../../application/runtime-api"
import { createCodesearchTool } from "../builtins/codesearch"
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

  return createToolRuntimeApi({
    tools: [
      createReadTool(),
      createGlobTool(),
      createGrepTool(),
      createWebfetchTool({ requestPermission }),
      createWebsearchTool({
        requestPermission,
        searchBackend: input.searchBackend,
      }),
      createCodesearchTool({
        requestPermission,
        searchBackend: input.searchBackend,
      }),
      createWriteTool({ requestPermission }),
      createEditTool({ requestPermission }),
      createShellTool({ requestPermission }),
      ...(input.extraTools ?? []),
    ],
  })
}
