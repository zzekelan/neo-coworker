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

const NO_RESULTS_MESSAGE =
  "No results found. Try: broader query terms, different keywords, checking spelling, or use webfetch with a specific URL if you already know the source."

const WebsearchArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty").describe(
    "Natural-language description of the ideal page to find, such as 'blog post comparing React and Vue performance 2024' or 'Next.js getServerSession JWT authentication example'. Describe the ideal content rather than using keyword fragments. Prefer full sentences or rich phrases over abbreviations.",
  ),
})

export function createWebsearchTool(input: {
  requestPermission: RequestToolPermission
  searchBackend?: SearchToolBackend
}): ToolDefinition {
  return {
    name: "websearch",
    description:
      "Search the web for current information, broad research, or candidate URLs using natural-language queries. Use this tool when the answer likely lives outside the repository — for news, current events, external documentation, or discovering relevant pages before fetching them with `webfetch`. Unlike `webfetch`, which retrieves a specific known URL, websearch discovers pages by query. Pass a natural-language description of the ideal page rather than keywords or a URL. Requires a configured search backend and explicit permission.",
    inputSchema: WebsearchArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    usageGuidance:
      "Prefer websearch over webfetch when you do not yet know the URL. Describe the ideal page content in natural language — 'tutorial on React server components with code examples' performs better than 'react server components'. Use webfetch once you have a URL to retrieve full page content. Do not use websearch for repository-local searches; use grep or glob instead.",
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

      const raw = await input.searchBackend({
        toolName: "websearch",
        query,
        signal: toolInput.signal,
      })

      const isEmpty = !raw || raw.trim().length === 0
      const output = isEmpty ? NO_RESULTS_MESSAGE : raw
      const resultCount = isEmpty ? 0 : 1

      return {
        output,
        metadata: {
          query,
          resultCount,
          truncated: false,
        },
      }
    },
  }
}
