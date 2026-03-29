import type { RequestToolPermission, ToolDefinition } from "../../domain"
import { createToolRuntimeApi } from "../../application/runtime-api"
import { createEditTool } from "../builtins/edit"
import { createGlobTool } from "../builtins/glob"
import { createReadTool } from "../builtins/read"
import { createSearchTool } from "../builtins/search"
import { createShellTool } from "../builtins/shell"
import { createWriteTool } from "../builtins/write"

const denyPermission: RequestToolPermission = async () => ({ decision: "deny" })

export type CreateBuiltinToolRuntimeInput = {
  requestPermission?: RequestToolPermission
  extraTools?: ToolDefinition[]
}

export function createBuiltinToolRuntime(input: CreateBuiltinToolRuntimeInput = {}) {
  const requestPermission = input.requestPermission ?? denyPermission

  return createToolRuntimeApi({
    tools: [
      createReadTool(),
      createGlobTool(),
      createSearchTool(),
      createWriteTool({ requestPermission }),
      createEditTool({ requestPermission }),
      createShellTool({ requestPermission }),
      ...(input.extraTools ?? []),
    ],
  })
}
