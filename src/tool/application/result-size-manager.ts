import type { ToolExecutionResult } from "../domain/result"

const DEFAULT_LIMIT = 50_000

export function manageResultSize(
  result: ToolExecutionResult,
  limit: number = DEFAULT_LIMIT,
): ToolExecutionResult {
  if (result.isError) {
    return result
  }

  const originalSize = Buffer.byteLength(result.output, "utf8")

  if (originalSize <= limit) {
    return result
  }

  const truncated = Buffer.from(result.output, "utf8").subarray(0, limit).toString("utf8")
  const suffix = `\n\n[Result truncated: ${originalSize}B → ${truncated.length}B. Full result available in tool execution metadata.]`

  return {
    ...result,
    output: truncated + suffix,
    metadata: {
      ...result.metadata,
      truncated: true,
      originalSize,
    },
  }
}
