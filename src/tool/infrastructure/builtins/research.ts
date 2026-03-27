import { z } from "zod"
import {
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import type { BuiltinResearchToolCallbacks } from "../../application"
import { createToolPermissionDeniedError } from "./errors"

const ResearchAssetKindSchema = z.enum(["source", "note", "finding", "artifact"])

const WebFetchArgsSchema = z.object({
  url: z.string().url("URL must be absolute"),
})

const ResearchListArgsSchema = z.object({
  kind: ResearchAssetKindSchema.optional(),
})

const ResearchReadArgsSchema = z.object({
  assetId: z.string().trim().min(1, "assetId must not be empty"),
})

const ResearchSearchArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty"),
  kind: ResearchAssetKindSchema.optional(),
})

const ResearchWriteArgsSchema = z.object({
  kind: ResearchAssetKindSchema,
  title: z.string().trim().min(1, "Title must not be empty"),
  content: z.string().trim().min(1, "Content must not be empty"),
})

export function createWebFetchTool(input: {
  requestPermission: RequestToolPermission
  research: BuiltinResearchToolCallbacks
}): ToolDefinition {
  return {
    name: "web_fetch",
    description:
      "Fetch a web page after approval, then stage it as candidate material instead of saving it directly",
    inputSchema: WebFetchArgsSchema,
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { url } = WebFetchArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "web_fetch",
        reason: `fetch ${url}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      const fetched = await fetchExternalContent({
        url,
        signal: value.signal,
        research: input.research,
      })
      throwIfToolAborted(value.signal)
      const candidate = await input.research.stageFetchedSource({
        workspaceRoot: value.workspaceRoot,
        sessionId: value.sessionId,
        runId: value.runId,
        title: fetched.title,
        sourceUrl: fetched.sourceUrl,
        content: fetched.content,
      })

      return {
        output: [
          `Staged candidate material ${candidate.id}.`,
          `Title: ${candidate.title}`,
          `Source URL: ${candidate.sourceUrl}`,
          `Excerpt: ${candidate.excerpt}`,
          "This material is not a saved source until the user confirms it in the project UI.",
        ].join("\n"),
      }
    },
  }
}

export function createResearchListAssetsTool(input: {
  research: BuiltinResearchToolCallbacks
}): ToolDefinition {
  return {
    name: "research_list_assets",
    description: "List durable project research assets saved in the current workspace",
    inputSchema: ResearchListArgsSchema,
    async execute(value) {
      const { kind } = ResearchListArgsSchema.parse(value.args)
      const assets = await input.research.listAssets({
        workspaceRoot: value.workspaceRoot,
        kind,
      })

      return {
        output:
          assets.length === 0
            ? "No durable research assets are saved in this workspace yet."
            : assets
                .map(
                  (asset) =>
                    `${asset.id} | ${asset.kind} | ${asset.title} | ${asset.path} | ${asset.snippet}`,
                )
                .join("\n"),
      }
    },
  }
}

export function createResearchReadAssetTool(input: {
  research: BuiltinResearchToolCallbacks
}): ToolDefinition {
  return {
    name: "research_read_asset",
    description: "Read the full contents of a saved research asset by asset id",
    inputSchema: ResearchReadArgsSchema,
    async execute(value) {
      const { assetId } = ResearchReadArgsSchema.parse(value.args)
      const asset = await input.research.readAsset({
        workspaceRoot: value.workspaceRoot,
        assetId,
      })

      return {
        output: [
          `Asset: ${asset.id}`,
          `Kind: ${asset.kind}`,
          `Title: ${asset.title}`,
          `Path: ${asset.path}`,
          asset.sourceUrl ? `Source URL: ${asset.sourceUrl}` : null,
          "",
          asset.content,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      }
    },
  }
}

export function createResearchSearchAssetsTool(input: {
  research: BuiltinResearchToolCallbacks
}): ToolDefinition {
  return {
    name: "research_search_assets",
    description: "Search saved research assets by title and content",
    inputSchema: ResearchSearchArgsSchema,
    async execute(value) {
      const { query, kind } = ResearchSearchArgsSchema.parse(value.args)
      const matches = await input.research.searchAssets({
        workspaceRoot: value.workspaceRoot,
        query,
        kind,
      })

      return {
        output:
          matches.length === 0
            ? `No saved research assets matched "${query}".`
            : matches
                .map(
                  (match) => `${match.id} | ${match.kind} | ${match.title} | ${match.snippet}`,
                )
                .join("\n"),
      }
    },
  }
}

export function createResearchWriteAssetTool(input: {
  research: BuiltinResearchToolCallbacks
}): ToolDefinition {
  return {
    name: "research_write_asset",
    description:
      "Save a durable note, finding, or artifact into the project knowledge store",
    inputSchema: ResearchWriteArgsSchema,
    async execute(value) {
      const { kind, title, content } = ResearchWriteArgsSchema.parse(value.args)
      const asset = await input.research.writeAsset({
        workspaceRoot: value.workspaceRoot,
        sessionId: value.sessionId,
        runId: value.runId,
        kind,
        title,
        content,
      })

      return {
        output: `Saved ${asset.kind} ${asset.id} at ${asset.path}.`,
      }
    },
  }
}

async function fetchExternalContent(input: {
  url: string
  signal?: AbortSignal
  research: BuiltinResearchToolCallbacks
}) {
  if (input.research.fetchExternalContent) {
    return input.research.fetchExternalContent({
      url: input.url,
      signal: input.signal,
    })
  }

  const response = await fetch(input.url, {
    method: "GET",
    signal: input.signal,
    headers: {
      accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8",
    },
  })

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }

  const contentType = response.headers.get("content-type")
  const body = await response.text()
  const title = extractDocumentTitle(body, input.url)
  const content = contentType?.includes("html") ? htmlToText(body) : body.trim()

  return {
    title,
    sourceUrl: input.url,
    content,
    contentType,
  }
}

function extractDocumentTitle(content: string, fallbackUrl: string) {
  const match = content.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = match?.[1]?.replace(/\s+/g, " ").trim()

  if (title) {
    return title
  }

  try {
    const url = new URL(fallbackUrl)
    return url.hostname
  } catch {
    return fallbackUrl
  }
}

function htmlToText(content: string) {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
}
