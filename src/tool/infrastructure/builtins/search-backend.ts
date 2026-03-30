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

    return await searchExa({
      toolName: request.toolName,
      query: request.query,
      signal: request.signal,
      fetchImpl,
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

async function searchExa(input: {
  toolName: SearchToolName
  query: string
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<string> {
  const responseText = await fetchText({
    url: new URL("https://mcp.exa.ai/mcp"),
    method: "POST",
    body: JSON.stringify(buildExaRequest(input.toolName, input.query)),
    fetchImpl: input.fetchImpl,
    signal: input.signal,
    accept: "application/json, text/event-stream",
  })

  const output = parseExaResponse(responseText)
  if (output) {
    return output
  }

  return input.toolName === "codesearch"
    ? `No code results found for "${input.query}".`
    : `No web results found for "${input.query}".`
}

async function fetchText(input: {
  url: URL
  method?: string
  body?: string
  signal?: AbortSignal
  fetchImpl: FetchLike
  accept?: string
}): Promise<string> {
  throwIfToolAborted(input.signal)
  const response = await input.fetchImpl(input.url, {
    method: input.method,
    headers: {
      accept: input.accept ?? "application/json",
      ...(input.body ? { "content-type": "application/json" } : {}),
      "user-agent": "neo-coworker-search/1.0",
    },
    body: input.body,
    signal: input.signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      errorText.trim()
        ? `Public search request failed with status ${response.status}: ${errorText.trim()}`
        : `Public search request failed with status ${response.status}`,
    )
  }

  return await response.text()
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
