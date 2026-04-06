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
  query: z.string().trim().min(1, "Query must not be empty").describe(
    "Technical search query for API, library, or code-oriented information, such as `zod describe json schema openai tools` or `bun spawn stdout pipe example`.",
  ),
}).describe(
  "Search technical documentation and code-oriented external context through the configured backend. Use this for library APIs, framework behavior, exact error strings, or implementation patterns when repository-local search is not enough. This tool requires permission and depends on the external search backend being configured. Pass a targeted technical query with library names, APIs, or error text for the best results.",
)

export function createCodesearchTool(input: {
  requestPermission: RequestToolPermission
  searchBackend?: SearchToolBackend
}): ToolDefinition {
  return {
    name: "codesearch",
    description:
      "Search technical documentation and code-oriented external context through the configured backend. Use this for library APIs, framework behavior, exact error strings, or implementation patterns when repository-local search is not enough. This tool requires permission and depends on the external search backend being configured. Pass a targeted technical query with library names, APIs, or error text for the best results.",
    inputSchema: CodesearchArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
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
