import { z } from "zod"
import {
  createToolAbortError,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"

const MAX_RESPONSE_BYTES = 1048576

const BINARY_CONTENT_TYPE_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "application/octet-stream",
  "application/zip",
  "application/x-zip",
  "application/gzip",
  "application/x-gzip",
  "application/pdf",
  "application/wasm",
  "font/",
]

const WebfetchArgsSchema = z.object({
  url: z.string().url().describe(
    "Absolute URL to fetch, e.g. `https://docs.example.com/api/reference`. Must be a fully-qualified HTTP, HTTPS, or data URL — not a search query. HTTP URLs are automatically upgraded to HTTPS where possible.",
  ),
  format: z.enum(["markdown", "text", "html"]).optional().describe(
    "Preferred text format for the response body. Use `markdown` (default) for general-purpose content, `text` for plain-text extraction, or `html` to preserve the raw HTML markup.",
  ),
  timeout: z.number().int().min(1).max(120000).optional().describe(
    "Request timeout in milliseconds. Defaults to 30000 (30 seconds). Use a lower value like 5000 for quick checks, or a higher value for slow documentation sites.",
  ),
}).describe(
  "Fetch text content from a specific URL and return it as readable text. Supports HTTP, HTTPS, and data URLs. HTTP responses are automatically followed for up to 20 redirects. Binary content (images, PDFs, archives) is detected by Content-Type header and described rather than returned raw. Responses exceeding 1 MB are automatically truncated. Use `websearch` first when you need to discover the right URL.",
)

function isBinaryContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase()
  return BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

export function createWebfetchTool(input: {
  requestPermission: RequestToolPermission
}): ToolDefinition {
  return {
    name: "webfetch",
    description:
      "Fetch text content from a specific URL and return it as readable text. Supports HTTP, HTTPS, and data URLs. Detects binary content (images, PDFs, archives) by Content-Type and returns a description instead of raw bytes. Responses exceeding 1 MB are truncated. Returns structured metadata including statusCode, contentType, contentLength, and truncated flag. Use `websearch` first when you need to discover the right URL.",
    inputSchema: WebfetchArgsSchema,
    concurrency: "read-only",
    isCompressible: true,
    resultSizeLimit: 100000,
    async execute(toolInput) {
      throwIfToolAborted(toolInput.signal)
      const { url, timeout = 30000 } = WebfetchArgsSchema.parse(toolInput.args)
      const decision = await input.requestPermission({
        toolName: "webfetch",
        reason: `webfetch ${url}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      const timeoutController = new AbortController()
      const timeoutId = setTimeout(() => timeoutController.abort(), timeout)

      const combinedSignal = toolInput.signal
        ? AbortSignal.any([toolInput.signal, timeoutController.signal])
        : timeoutController.signal

      try {
        const response = await fetch(url, {
          signal: combinedSignal,
          redirect: "follow",
        })

        clearTimeout(timeoutId)

        const statusCode = response.status
        const contentType = response.headers.get("content-type") ?? "application/octet-stream"
        const contentLengthHeader = response.headers.get("content-length")

        if (isBinaryContentType(contentType)) {
          const contentLength = contentLengthHeader !== null ? parseInt(contentLengthHeader, 10) : 0
          return {
            output: `This URL returned binary content (${contentType}). Binary content cannot be displayed as text. Content-Length: ${contentLength > 0 ? contentLength : "unknown"} bytes.`,
            metadata: {
              statusCode,
              contentType,
              contentLength,
              truncated: false,
            },
          }
        }

        if (statusCode < 200 || statusCode >= 300) {
          const errorBody = await response.text().catch(() => "")
          const contentLength = errorBody.length
          return {
            output: `webfetch failed: HTTP ${statusCode} ${response.statusText}${errorBody ? `\n${errorBody.slice(0, 500)}` : ""}`,
            isError: true,
            metadata: {
              statusCode,
              contentType,
              contentLength,
              truncated: false,
            },
          }
        }

        const bodyText = await response.text()
        const truncated = bodyText.length > MAX_RESPONSE_BYTES
        const finalBody = truncated
          ? `${bodyText.slice(0, MAX_RESPONSE_BYTES)}\n\n[Response truncated: content exceeded 1 MB limit. ${bodyText.length - MAX_RESPONSE_BYTES} bytes omitted.]`
          : bodyText

        const contentLength = contentLengthHeader !== null
          ? parseInt(contentLengthHeader, 10)
          : bodyText.length

        return {
          output: finalBody,
          metadata: {
            statusCode,
            contentType,
            contentLength,
            truncated,
          },
        }
      } catch (error) {
        clearTimeout(timeoutId)

        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        ) {
          const isToolAbort = toolInput.signal?.aborted && !timeoutController.signal.aborted
          if (isToolAbort) {
            throw createToolAbortError()
          }
          return {
            output: `webfetch timeout: request to ${url} exceeded ${timeout}ms limit.`,
            isError: true,
            metadata: {
              statusCode: 0,
              contentType: "",
              contentLength: 0,
              truncated: false,
            },
          }
        }

        throw error
      }
    },
  }
}
