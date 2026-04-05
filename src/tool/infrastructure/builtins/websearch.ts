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
  query: z.string().trim().min(1, "Query must not be empty").describe(
    "Natural-language web search query describing the information you need, such as `latest Bun shell API docs` or `OpenAI tool calling JSON schema examples`.",
  ),
}).describe(
  "Search the web for external information using the configured search backend. Use this when the answer likely lives outside the repository, especially for current facts, broad research, or finding candidate URLs before using `webfetch`. This tool requires permission and only works when a search backend is configured. Pass a focused natural-language query rather than a URL.",
)

export function createWebsearchTool(input: {
  requestPermission: RequestToolPermission
  searchBackend?: SearchToolBackend
}): ToolDefinition {
  return {
    name: "websearch",
    description:
      "Search the web for external information using the configured search backend. Use this when the answer likely lives outside the repository, especially for current facts, broad research, or finding candidate URLs before using `webfetch`. This tool requires permission and only works when a search backend is configured. Pass a focused natural-language query rather than a URL.",
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
