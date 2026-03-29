import { z } from "zod"
import {
  type RequestToolPermission,
  throwIfToolAborted,
  type ToolDefinition,
} from "../../domain"
import {
  type SearchToolBackend,
} from "./search-backend"
import {
  createToolPermissionDeniedError,
  createToolSetupError,
} from "./errors"

const WebsearchArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty"),
})

export function createWebsearchTool(input: {
  requestPermission: RequestToolPermission
  searchBackend?: SearchToolBackend
}): ToolDefinition {
  return {
    name: "websearch",
    description: "Search the web for relevant external information",
    inputSchema: WebsearchArgsSchema,
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { query } = WebsearchArgsSchema.parse(toolInput.args)
      const decision = await input.requestPermission({
        toolName: "websearch",
        reason: `websearch ${query}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      if (!input.searchBackend) {
        throw createToolSetupError(
          "Setup error: SEARCH_BACKEND_URL is required to enable websearch",
        )
      }

      return {
        output: await input.searchBackend({
          toolName: "websearch",
          query,
          signal: toolInput.signal,
        }),
      }
    },
  }
}
