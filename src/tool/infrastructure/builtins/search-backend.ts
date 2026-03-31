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

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>

type ExaMcpRequest = {
  jsonrpc: "2.0"
  id: number
  method: "tools/call"
  params: {
    name: "web_search_exa" | "get_code_context_exa"
    arguments: Record<string, string | number>
  }
}

type ExaMcpResponse = {
  error?: {
    code?: number
    message?: string
  }
  result?: {
    content?: Array<{
      type?: string
      text?: string
    }>
  }
}

type PublicSearchProviderInput = {
  toolName: SearchToolName
  query: string
  signal?: AbortSignal
  fetchImpl: FetchLike
}

type PublicSearchProvider = (input: PublicSearchProviderInput) => Promise<string | null>

type SearchResultCandidate = {
  title: string
  url: string
  summary?: string
}

type DuckDuckGoTopic = {
  FirstURL?: string
  Text?: string
  Topics?: DuckDuckGoTopic[]
}

type DuckDuckGoResponse = {
  Heading?: string
  AbstractText?: string
  AbstractURL?: string
  Results?: DuckDuckGoTopic[]
  RelatedTopics?: DuckDuckGoTopic[]
}

type WikipediaSearchResponse = {
  pages?: Array<{
    key?: string
    title?: string
    description?: string
    excerpt?: string
  }>
}

type MdnSearchResponse = {
  documents?: Array<{
    title?: string
    mdn_url?: string
    summary?: string
  }>
}

class PublicSearchProviderRequestError extends Error {
  readonly providerName: string
  readonly url: string

  constructor(input: { providerName: string; url: string; message: string }) {
    super(input.message)
    this.name = "PublicSearchProviderRequestError"
    this.providerName = input.providerName
    this.url = input.url
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

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

    return await searchPublicProviders({
      toolName: request.toolName,
      query: request.query,
      signal: request.signal,
      fetchImpl,
      providers:
        request.toolName === "codesearch"
          ? [searchExa, searchMdn]
          : [searchExa, searchDuckDuckGo, searchWikipedia],
    })
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

async function searchPublicProviders(
  input: PublicSearchProviderInput & {
    providers: PublicSearchProvider[]
  },
): Promise<string> {
  let sawSuccessfulResponse = false
  let lastContinuableError: PublicSearchProviderRequestError | null = null

  for (const provider of input.providers) {
    throwIfToolAborted(input.signal)

    try {
      const output = await provider(input)
      sawSuccessfulResponse = true
      if (output && output.trim()) {
        return output
      }
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) {
        throw createToolAbortError()
      }

      if (!(error instanceof PublicSearchProviderRequestError)) {
        throw error
      }

      lastContinuableError = error
    }
  }

  if (lastContinuableError && !sawSuccessfulResponse) {
    throw lastContinuableError
  }

  return buildNoResultsMessage(input.toolName, input.query)
}

async function searchExa(input: PublicSearchProviderInput): Promise<string | null> {
  const responseText = await fetchText({
    url: new URL("https://mcp.exa.ai/mcp"),
    method: "POST",
    body: JSON.stringify(buildExaRequest(input.toolName, input.query)),
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    accept: "application/json, text/event-stream",
    providerName: "Exa MCP",
  })

  return parseExaResponse(responseText)
}

async function searchDuckDuckGo(input: PublicSearchProviderInput): Promise<string | null> {
  const url = new URL("https://api.duckduckgo.com/")
  url.searchParams.set("q", input.query)
  url.searchParams.set("format", "json")
  url.searchParams.set("no_html", "1")
  url.searchParams.set("skip_disambig", "1")

  const responseText = await fetchText({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    providerName: "DuckDuckGo",
  })

  return parseDuckDuckGoResponse(responseText, input.query)
}

async function searchWikipedia(input: PublicSearchProviderInput): Promise<string | null> {
  const url = new URL("https://en.wikipedia.org/w/rest.php/v1/search/title")
  url.searchParams.set("q", input.query)
  url.searchParams.set("limit", "5")

  const responseText = await fetchText({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    providerName: "Wikipedia Search",
  })

  return parseWikipediaSearchResponse(responseText, input.query)
}

async function searchMdn(input: PublicSearchProviderInput): Promise<string | null> {
  const url = new URL("https://developer.mozilla.org/api/v1/search")
  url.searchParams.set("q", input.query)

  const responseText = await fetchText({
    url,
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    providerName: "MDN Search",
  })

  return parseMdnSearchResponse(responseText, input.query)
}

async function fetchText(input: {
  url: URL
  method?: string
  body?: string
  signal?: AbortSignal
  fetchImpl: FetchLike
  accept?: string
  providerName: string
}): Promise<string> {
  throwIfToolAborted(input.signal)

  let response: Response
  try {
    response = await input.fetchImpl(input.url, {
      method: input.method,
      headers: {
        accept: input.accept ?? "application/json",
        ...(input.body ? { "content-type": "application/json" } : {}),
        "user-agent": "neo-coworker-search/1.0",
      },
      body: input.body,
      signal: input.signal,
    })
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) {
      throw createToolAbortError()
    }

    throw new PublicSearchProviderRequestError({
      providerName: input.providerName,
      url: input.url.toString(),
      message: `${input.providerName} request failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw new PublicSearchProviderRequestError({
      providerName: input.providerName,
      url: input.url.toString(),
      message: errorText.trim()
        ? `${input.providerName} request failed with status ${response.status}: ${errorText.trim()}`
        : `${input.providerName} request failed with status ${response.status}`,
    })
  }

  return await response.text()
}

function buildNoResultsMessage(toolName: SearchToolName, query: string) {
  return toolName === "codesearch"
    ? `No code results found for "${query}".`
    : `No web results found for "${query}".`
}

function buildExaRequest(toolName: SearchToolName, query: string): ExaMcpRequest {
  if (toolName === "codesearch") {
    return {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "get_code_context_exa",
        arguments: {
          query,
          tokensNum: 5000,
        },
      },
    }
  }

  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query,
        type: "auto",
        numResults: 8,
        livecrawl: "fallback",
      },
    },
  }
}

function parseExaResponse(responseText: string) {
  const sseOutput = parseExaEventStream(responseText)
  if (sseOutput) {
    return sseOutput
  }

  let payload: ExaMcpResponse
  try {
    payload = JSON.parse(responseText) as ExaMcpResponse
  } catch {
    return null
  }

  return readExaResponseText(payload)
}

function parseDuckDuckGoResponse(responseText: string, query: string) {
  let payload: DuckDuckGoResponse
  try {
    payload = JSON.parse(responseText) as DuckDuckGoResponse
  } catch {
    return null
  }

  const candidates: SearchResultCandidate[] = []
  if (
    typeof payload.AbstractURL === "string" &&
    payload.AbstractURL.trim() &&
    typeof payload.AbstractText === "string" &&
    payload.AbstractText.trim()
  ) {
    candidates.push({
      title:
        typeof payload.Heading === "string" && payload.Heading.trim() ? payload.Heading.trim() : query,
      url: payload.AbstractURL.trim(),
      summary: payload.AbstractText.trim(),
    })
  }

  for (const topic of [
    ...flattenDuckDuckGoTopics(payload.Results),
    ...flattenDuckDuckGoTopics(payload.RelatedTopics),
  ]) {
    if (
      typeof topic.FirstURL !== "string" ||
      !topic.FirstURL.trim() ||
      typeof topic.Text !== "string" ||
      !topic.Text.trim()
    ) {
      continue
    }

    candidates.push({
      title: topic.Text.split(" - ").at(0)?.trim() || topic.Text.trim(),
      url: topic.FirstURL.trim(),
      summary: topic.Text.trim(),
    })
  }

  return formatSearchResults({
    heading: "Top web results",
    query,
    candidates,
  })
}

function parseWikipediaSearchResponse(responseText: string, query: string) {
  let payload: WikipediaSearchResponse
  try {
    payload = JSON.parse(responseText) as WikipediaSearchResponse
  } catch {
    return null
  }

  const candidates =
    payload.pages?.flatMap((page) => {
      if (
        typeof page.key !== "string" ||
        !page.key.trim() ||
        typeof page.title !== "string" ||
        !page.title.trim()
      ) {
        return []
      }

      const description =
        typeof page.description === "string" && page.description.trim()
          ? page.description.trim()
          : typeof page.excerpt === "string" && page.excerpt.trim()
            ? stripHtml(page.excerpt).trim()
            : undefined

      return [
        {
          title: page.title.trim(),
          url: `https://en.wikipedia.org/wiki/${page.key.trim()}`,
          summary: description,
        } satisfies SearchResultCandidate,
      ]
    }) ?? []

  return formatSearchResults({
    heading: "Top web results",
    query,
    candidates,
  })
}

function parseMdnSearchResponse(responseText: string, query: string) {
  let payload: MdnSearchResponse
  try {
    payload = JSON.parse(responseText) as MdnSearchResponse
  } catch {
    return null
  }

  const candidates =
    payload.documents?.flatMap((document) => {
      if (
        typeof document.mdn_url !== "string" ||
        !document.mdn_url.trim() ||
        typeof document.title !== "string" ||
        !document.title.trim()
      ) {
        return []
      }

      return [
        {
          title: document.title.trim(),
          url: buildMdnUrl(document.mdn_url),
          summary:
            typeof document.summary === "string" && document.summary.trim()
              ? document.summary.trim()
              : undefined,
        } satisfies SearchResultCandidate,
      ]
    }) ?? []

  return formatSearchResults({
    heading: "Top code/API results",
    query,
    candidates,
  })
}

function formatSearchResults(input: {
  heading: string
  query: string
  candidates: SearchResultCandidate[]
}) {
  const seenUrls = new Set<string>()
  const uniqueCandidates = input.candidates.filter((candidate) => {
    const url = candidate.url.trim()
    if (!url || seenUrls.has(url)) {
      return false
    }

    seenUrls.add(url)
    return true
  })

  if (uniqueCandidates.length === 0) {
    return null
  }

  return [
    `${input.heading} for "${input.query}"`,
    ...uniqueCandidates.slice(0, 3).map((candidate, index) => {
      const lines = [`${index + 1}. ${candidate.title}`, `URL: ${candidate.url}`]
      if (candidate.summary) {
        lines.push(`Summary: ${candidate.summary}`)
      }
      return lines.join("\n")
    }),
  ].join("\n")
}

function flattenDuckDuckGoTopics(topics: DuckDuckGoTopic[] | undefined): DuckDuckGoTopic[] {
  if (!Array.isArray(topics)) {
    return []
  }

  const flattened: DuckDuckGoTopic[] = []
  for (const topic of topics) {
    if (Array.isArray(topic.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(topic.Topics))
      continue
    }

    flattened.push(topic)
  }

  return flattened
}

function stripHtml(text: string) {
  return text.replace(/<[^>]+>/g, "")
}

function buildMdnUrl(path: string) {
  return new URL(path, "https://developer.mozilla.org").toString()
}

function parseExaEventStream(responseText: string) {
  const lines = responseText.split(/\r?\n/)
  let dataSegments: string[] = []

  for (const line of lines) {
    if (line === "") {
      const text = parseExaEventStreamPayload(dataSegments)
      if (text) {
        return text
      }

      dataSegments = []
      continue
    }

    if (line.startsWith(":")) {
      continue
    }

    const separatorIndex = line.indexOf(":")
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    if (field !== "data") {
      continue
    }

    let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1)
    if (value.startsWith(" ")) {
      value = value.slice(1)
    }
    dataSegments.push(value)
  }

  return parseExaEventStreamPayload(dataSegments)
}

function parseExaEventStreamPayload(dataSegments: string[]) {
  const payloadText = dataSegments.join("\n").trim()
  if (!payloadText) {
    return null
  }

  let payload: ExaMcpResponse
  try {
    payload = JSON.parse(payloadText) as ExaMcpResponse
  } catch {
    return null
  }

  return readExaResponseText(payload)
}

function readExaResponseText(payload: ExaMcpResponse) {
  if (payload.error) {
    const codeSuffix =
      typeof payload.error.code === "number"
        ? ` (${payload.error.code})`
        : ""
    const message =
      typeof payload.error.message === "string" && payload.error.message.trim()
        ? payload.error.message.trim()
        : "unknown Exa MCP error"
    throw new Error(`Setup error: Public search backend failed${codeSuffix}: ${message}`)
  }

  return readExaContentText(payload)
}

function readExaContentText(payload: ExaMcpResponse) {
  const content = payload.result?.content
  if (!Array.isArray(content)) {
    return null
  }

  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
      return item.text
    }
  }

  return null
}
