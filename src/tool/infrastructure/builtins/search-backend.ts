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
