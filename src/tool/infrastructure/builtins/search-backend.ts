import { request as requestHttp } from "node:http"
import { request as requestHttps } from "node:https"
import {
  createToolAbortError,
  throwIfToolAborted,
} from "../../domain"

export type SearchToolName = "websearch" | "codesearch"

export type SearchToolBackendRequest = {
  toolName: SearchToolName
  query: string
  signal?: AbortSignal
}

export type SearchToolBackend = (
  input: SearchToolBackendRequest,
) => Promise<string>

export type HttpSearchToolBackendConfig = {
  url: string
  bearerToken?: string
}

type SearchResultEntry = {
  title: string
  url: string
  snippet?: string
}

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>

export function createHttpSearchToolBackend(
  config: HttpSearchToolBackendConfig,
): SearchToolBackend {
  return async function searchBackend(input) {
    throwIfToolAborted(input.signal)

    const responseText = await postJson({
      url: config.url,
      bearerToken: config.bearerToken,
      body: JSON.stringify({
        toolName: input.toolName,
        query: input.query,
      }),
      signal: input.signal,
    })

    return parseSearchBackendOutput(responseText, input.toolName)
  }
}

export function createPublicSearchToolBackend(input: {
  fetchImpl?: FetchLike
} = {}): SearchToolBackend {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis)

  return async function searchBackend(request) {
    throwIfToolAborted(request.signal)

    if (request.toolName === "codesearch") {
      const mdnResults = await searchMdn({
        query: request.query,
        signal: request.signal,
        fetchImpl,
      })
      if (mdnResults.length > 0) {
        return formatSearchResults({
          heading: `Top code results for "${request.query}"`,
          results: mdnResults,
        })
      }

      const stackOverflowResults = await searchStackOverflow({
        query: request.query,
        signal: request.signal,
        fetchImpl,
      })
      if (stackOverflowResults.length > 0) {
        return formatSearchResults({
          heading: `Top code results for "${request.query}"`,
          results: stackOverflowResults,
        })
      }

      return `No code results found for "${request.query}".`
    }

    const duckDuckGoResults = await searchDuckDuckGo({
      query: request.query,
      signal: request.signal,
      fetchImpl,
    })
    if (duckDuckGoResults.length > 0) {
      return formatSearchResults({
        heading: `Top web results for "${request.query}"`,
        results: duckDuckGoResults,
      })
    }

    const wikipediaResults = await searchWikipedia({
      query: request.query,
      signal: request.signal,
      fetchImpl,
    })
    if (wikipediaResults.length > 0) {
      return formatSearchResults({
        heading: `Top web results for "${request.query}"`,
        results: wikipediaResults,
      })
    }

    return `No web results found for "${request.query}".`
  }
}

function parseSearchBackendOutput(responseText: string, toolName: SearchToolName) {
  let payload: unknown

  try {
    payload = JSON.parse(responseText)
  } catch {
    return responseText
  }

  if (typeof payload === "string") {
    return payload
  }

  if (
    payload &&
    typeof payload === "object" &&
    "output" in payload &&
    typeof payload.output === "string"
  ) {
    return payload.output
  }

  throw new Error(`${toolName} backend returned an invalid response`)
}

async function postJson(input: {
  url: string
  body: string
  bearerToken?: string
  signal?: AbortSignal
}): Promise<string> {
  const target = new URL(input.url)

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Search backend URL must use http or https")
  }

  const request = (target.protocol === "https:" ? requestHttps : requestHttp)(target, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain",
      "content-type": "application/json",
      ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
    },
  })

  return await new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      request.destroy(createToolAbortError())
    }

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort()
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0

      if (statusCode < 200 || statusCode >= 300) {
        response.setEncoding("utf8")
        let errorBody = ""
        response.on("data", (chunk: string) => {
          errorBody += chunk
        })
        response.on("end", () => {
          cleanup()
          reject(
            new Error(
              errorBody.trim()
                ? `Search backend failed with status ${statusCode}: ${errorBody.trim()}`
                : `Search backend failed with status ${statusCode}`,
            ),
          )
        })
        response.on("error", (error) => {
          cleanup()
          reject(error)
        })
        return
      }

      response.setEncoding("utf8")
      let body = ""

      response.on("data", (chunk: string) => {
        body += chunk
      })
      response.on("end", () => {
        cleanup()
        resolve(body)
      })
      response.on("error", (error) => {
        cleanup()
        reject(error)
      })
    })

    request.on("error", (error) => {
      cleanup()
      reject(error)
    })
    request.write(input.body)
    request.end()

    function cleanup() {
      input.signal?.removeEventListener("abort", onAbort)
    }
  })
}

async function searchDuckDuckGo(input: {
  query: string
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<SearchResultEntry[]> {
  const url = new URL("https://api.duckduckgo.com/")
  url.searchParams.set("q", input.query)
  url.searchParams.set("format", "json")
  url.searchParams.set("no_html", "1")
  url.searchParams.set("no_redirect", "1")
  url.searchParams.set("skip_disambig", "1")

  const payload = await fetchJson({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  })

  const results: SearchResultEntry[] = []
  if (!isRecord(payload)) {
    return results
  }

  const abstractText = readString(payload, "AbstractText")
  const abstractUrl = readString(payload, "AbstractURL")
  if (abstractText && abstractUrl) {
    results.push({
      title: readString(payload, "Heading") ?? titleFromUrl(abstractUrl),
      url: abstractUrl,
      snippet: abstractText,
    })
  }

  const relatedTopics = payload.RelatedTopics
  if (Array.isArray(relatedTopics)) {
    const flattened = flattenDuckDuckGoTopics(relatedTopics)
    for (const topic of flattened) {
      const text = readString(topic, "Text")
      const urlValue = readString(topic, "FirstURL")
      if (!text || !urlValue) {
        continue
      }

      const [title, ...rest] = text.split(" - ")
      results.push({
        title: title?.trim() || titleFromUrl(urlValue),
        url: urlValue,
        snippet: rest.join(" - ").trim() || text,
      })
    }
  }

  return dedupeResults(results)
}

async function searchWikipedia(input: {
  query: string
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<SearchResultEntry[]> {
  const url = new URL("https://en.wikipedia.org/w/api.php")
  url.searchParams.set("action", "opensearch")
  url.searchParams.set("search", input.query)
  url.searchParams.set("limit", "5")
  url.searchParams.set("namespace", "0")
  url.searchParams.set("format", "json")

  const payload = await fetchJson({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  })

  if (!Array.isArray(payload) || payload.length < 4) {
    return []
  }

  const titles = Array.isArray(payload[1]) ? payload[1] : []
  const descriptions = Array.isArray(payload[2]) ? payload[2] : []
  const links = Array.isArray(payload[3]) ? payload[3] : []
  const results: SearchResultEntry[] = []

  for (let index = 0; index < titles.length; index += 1) {
    const title = typeof titles[index] === "string" ? titles[index] : undefined
    const urlValue = typeof links[index] === "string" ? links[index] : undefined
    if (!title || !urlValue) {
      continue
    }

    const snippet = typeof descriptions[index] === "string" ? descriptions[index] : undefined
    results.push({
      title,
      url: urlValue,
      snippet,
    })
  }

  return dedupeResults(results)
}

async function searchMdn(input: {
  query: string
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<SearchResultEntry[]> {
  const url = new URL("https://developer.mozilla.org/api/v1/search")
  url.searchParams.set("q", input.query)
  url.searchParams.set("locale", "en-US")

  const payload = await fetchJson({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  })

  if (!isRecord(payload)) {
    return []
  }

  const documentsValue =
    (Array.isArray(payload.documents) && payload.documents) ||
    (Array.isArray(payload.results) && payload.results) ||
    (Array.isArray(payload.items) && payload.items) ||
    []

  const results: SearchResultEntry[] = []
  for (const entry of documentsValue) {
    if (!isRecord(entry)) {
      continue
    }

    const title = readString(entry, "title")
    const urlValue =
      normalizeUrl(readString(entry, "mdn_url")) ??
      normalizeUrl(readString(entry, "url")) ??
      normalizeUrl(readString(entry, "mdnUrl"))
    if (!title || !urlValue) {
      continue
    }

    results.push({
      title,
      url: urlValue,
      snippet:
        readString(entry, "summary") ??
        readString(entry, "excerpt") ??
        readString(entry, "summary_text"),
    })
  }

  return dedupeResults(results)
}

async function searchStackOverflow(input: {
  query: string
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<SearchResultEntry[]> {
  const url = new URL("https://api.stackexchange.com/2.3/search/advanced")
  url.searchParams.set("order", "desc")
  url.searchParams.set("sort", "relevance")
  url.searchParams.set("site", "stackoverflow")
  url.searchParams.set("pagesize", "5")
  url.searchParams.set("q", input.query)

  const payload = await fetchJson({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
  })

  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return []
  }

  const results: SearchResultEntry[] = []
  for (const item of payload.items) {
    if (!isRecord(item)) {
      continue
    }

    const title = readString(item, "title")
    const urlValue = readString(item, "link")
    if (!title || !urlValue) {
      continue
    }

    const tags = Array.isArray(item.tags)
      ? item.tags.filter((tag): tag is string => typeof tag === "string")
      : []

    results.push({
      title: decodeHtml(title),
      url: urlValue,
      snippet: tags.length > 0 ? `Tags: ${tags.join(", ")}` : undefined,
    })
  }

  return dedupeResults(results)
}

async function fetchJson(input: {
  url: URL
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<unknown> {
  throwIfToolAborted(input.signal)
  const response = await input.fetchImpl(input.url, {
    headers: {
      accept: "application/json",
      "user-agent": "neo-coworker-search/1.0",
    },
    signal: input.signal,
  })

  if (!response.ok) {
    throw new Error(`Public search request failed with status ${response.status}`)
  }

  return await response.json()
}

function formatSearchResults(input: {
  heading: string
  results: SearchResultEntry[]
}) {
  const lines = [input.heading + ":"]

  for (const [index, result] of input.results.slice(0, 5).entries()) {
    lines.push(`${index + 1}. ${result.title}`)
    lines.push(`URL: ${result.url}`)
    if (result.snippet) {
      lines.push(`Snippet: ${result.snippet}`)
    }
    lines.push("")
  }

  return lines.join("\n").trim()
}

function flattenDuckDuckGoTopics(topics: unknown[]): Record<string, unknown>[] {
  const flattened: Record<string, unknown>[] = []

  for (const topic of topics) {
    if (!isRecord(topic)) {
      continue
    }

    if (Array.isArray(topic.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(topic.Topics))
      continue
    }

    flattened.push(topic)
  }

  return flattened
}

function dedupeResults(results: SearchResultEntry[]) {
  const seen = new Set<string>()
  const deduped: SearchResultEntry[] = []

  for (const result of results) {
    const normalizedUrl = result.url.trim()
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue
    }

    seen.add(normalizedUrl)
    deduped.push({
      title: result.title.trim(),
      url: normalizedUrl,
      snippet: result.snippet?.trim() || undefined,
    })
  }

  return deduped
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" && value.trim() ? decodeHtml(stripTags(value)) : undefined
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ")
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeUrl(value: string | undefined) {
  if (!value) {
    return undefined
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value
  }

  if (value.startsWith("/")) {
    return `https://developer.mozilla.org${value}`
  }

  return undefined
}

function titleFromUrl(value: string) {
  try {
    const url = new URL(value)
    const lastPathname = url.pathname.split("/").filter(Boolean).pop()
    return lastPathname ? decodeURIComponent(lastPathname) : url.hostname
  } catch {
    return value
  }
}
