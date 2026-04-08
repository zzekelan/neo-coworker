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
  "No results found. Try: searching for actual code patterns (e.g. 'useState(' not 'how to use useState'), different library names, specific error messages, or use grep for local repository searches."

const CODESEARCH_METADATA_SOURCE = {
  type: "search-backend",
  channel: "code",
  toolName: "codesearch",
} as const

const CodesearchArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty").describe(
    "Actual code patterns, API names, or technical identifiers to search for, such as 'useState(' or 'import React from' or 'async function $NAME($$$)'. Search for literal code that would appear in files, not keyword descriptions. Include library names, method signatures, or error text for best results.",
  ),
})

export function createCodesearchTool(input: {
  requestPermission: RequestToolPermission
  searchBackend?: SearchToolBackend
}): ToolDefinition {
  return {
    name: "codesearch",
    description:
      "Search public code repositories for real-world implementation examples, library API usage patterns, and technical code snippets. Use this tool when you need to see how actual code is written in production repositories — for library APIs, framework integration patterns, specific function signatures, or error handling idioms that are not present in the local workspace. Unlike `grep` which searches the local repository, codesearch searches external public codebases. Pass actual code patterns (identifiers, function calls, import statements) rather than natural-language descriptions. Requires a configured search backend and explicit permission.",
    inputSchema: CodesearchArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    usageGuidance:
      "Use codesearch for external code examples when local grep/glob finds nothing useful. Search for actual code patterns like 'getServerSession(' or 'ErrorBoundary' rather than keyword descriptions like 'how to handle errors'. Filter by language or repository when you need targeted results. Use grep or glob for local workspace searches — codesearch is for discovering external patterns and real-world usage across public repositories.",
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

      const raw = await input.searchBackend({
        toolName: "codesearch",
        query,
        signal: toolInput.signal,
      })

      const isEmpty = !raw || raw.trim().length === 0
      const output = isEmpty ? NO_RESULTS_MESSAGE : raw
      const resultCount = isEmpty ? 0 : countSearchResults(raw)

      return {
        output,
        metadata: {
          source: CODESEARCH_METADATA_SOURCE,
          query,
          queryEcho: query,
          resultCount,
          truncated: false,
        },
      }
    },
  }
}

function countSearchResults(raw: string) {
  const numberedResults = raw.match(/^\d+\.\s+/gm)
  if (numberedResults && numberedResults.length > 0) {
    return numberedResults.length
  }

  const urlResults = raw.match(/^URL:\s+/gm)
  if (urlResults && urlResults.length > 0) {
    return urlResults.length
  }

  return 1
}
