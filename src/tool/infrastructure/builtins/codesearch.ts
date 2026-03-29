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

const CodesearchArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty"),
})

export function createCodesearchTool(input: {
  requestPermission: RequestToolPermission
  searchBackend?: SearchToolBackend
}): ToolDefinition {
  return {
    name: "codesearch",
    description: "Search technical docs and API-oriented context",
    inputSchema: CodesearchArgsSchema,
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { query } = CodesearchArgsSchema.parse(toolInput.args)
      const decision = await input.requestPermission({
        toolName: "codesearch",
        reason: `codesearch ${query}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      if (!input.searchBackend) {
        throw createToolSetupError(
          "Setup error: SEARCH_BACKEND_URL is required to enable codesearch",
        )
      }

      return {
        output: await input.searchBackend({
          toolName: "codesearch",
          query,
          signal: toolInput.signal,
        }),
      }
    },
  }
}
