import type { RequestToolPermission, ToolDefinition } from "../../domain"
import type { ToolObserverPort } from "../../application"
import { createToolRuntimeApi } from "../../application/runtime-api"
import { createApplyPatchTool } from "../builtins/apply-patch"
import { createCodesearchTool } from "../builtins/codesearch"
import { createDatetimeTool } from "../builtins/datetime"
import { createGlobTool } from "../builtins/glob"
import { createGrepTool } from "../builtins/grep"
import { createReadTool, type CreateReadToolInput } from "../builtins/read"
import { type SearchToolBackend } from "../builtins/search-backend"
import { createShellTool } from "../builtins/shell"
import { createWebfetchTool } from "../builtins/webfetch"
import { createWebsearchTool } from "../builtins/websearch"
import { createWriteTool } from "../builtins/write"
import { createMemoryTools, type MemoryToolStore } from "./memory-tools"

const denyPermission: RequestToolPermission = async () => ({ decision: "deny" })

export type CreateBuiltinToolRuntimeInput = {
  requestPermission?: RequestToolPermission
  searchBackend?: SearchToolBackend
  memory?: MemoryToolStore
  observer?: ToolObserverPort
  observerContext?: {
    sessionId: string
    runId: string
  }
  readAllowedAbsoluteRoots?: CreateReadToolInput["allowedAbsoluteRoots"]
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

    if (tool.name === "write" || tool.name === "edit" || tool.name === "apply_patch" || tool.name === "shell") {
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
      annotateDefaults(createReadTool({
        allowedAbsoluteRoots: input.readAllowedAbsoluteRoots,
      })),
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
      ...(input.memory ? createMemoryTools({ memory: input.memory }).map(annotateDefaults) : []),
      annotateDefaults(createApplyPatchTool({ requestPermission })),
      annotateDefaults(createWriteTool({ requestPermission })),
      annotateDefaults(createShellTool({ requestPermission })),
      ...(input.extraTools ?? []),
    ],
  })
}
