import type { BuiltinResearchToolCallbacks } from "../../application"
import type { RequestToolPermission } from "../../domain"
import { createToolRuntimeApi } from "../../application/runtime-api"
import { createEditTool } from "../builtins/edit"
import { createReadTool } from "../builtins/read"
import {
  createResearchListAssetsTool,
  createResearchReadAssetTool,
  createResearchSearchAssetsTool,
  createResearchWriteAssetTool,
  createWebFetchTool,
} from "../builtins/research"
import { createSearchTool } from "../builtins/search"
import { createShellTool } from "../builtins/shell"
import { createWriteTool } from "../builtins/write"

const denyPermission: RequestToolPermission = async () => ({ decision: "deny" })

export type CreateBuiltinToolRuntimeInput = {
  requestPermission?: RequestToolPermission
  research?: BuiltinResearchToolCallbacks
}

export function createBuiltinToolRuntime(input: CreateBuiltinToolRuntimeInput = {}) {
  const requestPermission = input.requestPermission ?? denyPermission
  const researchTools = input.research
    ? [
        createWebFetchTool({
          requestPermission,
          research: input.research,
        }),
        createResearchListAssetsTool({
          research: input.research,
        }),
        createResearchReadAssetTool({
          research: input.research,
        }),
        createResearchSearchAssetsTool({
          research: input.research,
        }),
        createResearchWriteAssetTool({
          research: input.research,
        }),
      ]
    : []

  return createToolRuntimeApi({
    tools: [
      createReadTool(),
      createSearchTool(),
      createWriteTool({ requestPermission }),
      createEditTool({ requestPermission }),
      createShellTool({ requestPermission }),
      ...researchTools,
    ],
  })
}
