import { request as requestHttp } from "node:http"
import { request as requestHttps } from "node:https"
import { z } from "zod"
import {
  createToolAbortError,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"

const WebfetchArgsSchema = z.object({
  url: z.string().url().describe(
    "Exact URL to fetch, such as `https://example.com/docs/api` or a redirecting documentation page. Pass a fully qualified URL, not a search query.",
  ),
}).describe(
  "Fetch text content from a specific URL. Use this when you already know the page you want and need its contents, such as documentation, API references, or a linked article; prefer `websearch` when you still need to discover the right page first. This tool requires permission because it accesses the network. It follows a small number of redirects and expects a valid absolute URL.",
)

export function createWebfetchTool(input: {
  requestPermission: RequestToolPermission
}): ToolDefinition {
  return {
    name: "webfetch",
    description:
      "Fetch text content from a specific URL. Use this when you already know the page you want and need its contents, such as documentation, API references, or a linked article; prefer `websearch` when you still need to discover the right page first. This tool requires permission because it accesses the network. It follows a small number of redirects and expects a valid absolute URL.",
    inputSchema: WebfetchArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { url } = WebfetchArgsSchema.parse(toolInput.args)
      const decision = await input.requestPermission({
        toolName: "webfetch",
        reason: `webfetch ${url}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      return {
        output: await fetchUrlText(url, toolInput.signal),
      }
    },
  }
}

async function fetchUrlText(
  url: string,
  signal: AbortSignal | undefined,
  redirectCount = 0,
): Promise<string> {
  throwIfToolAborted(signal)

  if (redirectCount > 5) {
    throw new Error("webfetch failed after too many redirects")
  }

  const target = new URL(url)

  if (target.protocol === "data:") {
    const response = await fetch(url, {
      signal,
    })

    if (!response.ok) {
      throw new Error(`webfetch failed with status ${response.status}`)
    }

    return await response.text()
  }

  const request = (target.protocol === "https:" ? requestHttps : requestHttp)(target)

  return await new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      request.destroy(createToolAbortError())
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0

      if (
        statusCode >= 300 &&
        statusCode < 400 &&
        typeof response.headers.location === "string"
      ) {
        response.resume()
        cleanup()
        resolve(fetchUrlText(new URL(response.headers.location, target).toString(), signal, redirectCount + 1))
        return
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        cleanup()
        reject(new Error(`webfetch failed with status ${statusCode}`))
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
    request.end()

    function cleanup() {
      signal?.removeEventListener("abort", onAbort)
    }
  })
}
