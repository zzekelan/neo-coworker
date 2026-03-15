import type { RequestToolPermission } from "../service"
import { createToolRuntimeApi } from "./api"
import { createEditTool } from "./edit"
import { createReadTool } from "./read"
import { createSearchTool } from "./search"
import { createShellTool } from "./shell"
import { createWriteTool } from "./write"

const denyPermission: RequestToolPermission = async () => ({ decision: "deny" })

export type CreateBuiltinToolRuntimeInput = {
  requestPermission?: RequestToolPermission
}

export function createBuiltinToolRuntime(input: CreateBuiltinToolRuntimeInput = {}) {
  const requestPermission = input.requestPermission ?? denyPermission

  return createToolRuntimeApi({
    tools: [
      createReadTool(),
      createSearchTool(),
      createWriteTool({ requestPermission }),
      createEditTool({ requestPermission }),
      createShellTool({ requestPermission }),
    ],
  })
}
