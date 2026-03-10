import type { ZodTypeAny } from "zod"

export type ToolExecutionResult = {
  output: string
}

export type ToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
  signal?: AbortSignal
}

export type ToolDefinition = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult> | ToolExecutionResult
}

export type ToolRegistry = {
  list(): Array<Pick<ToolDefinition, "name" | "description" | "inputSchema">>
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult>
}

export function createAbortError(message = "Operation aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

export function throwIfAborted(signal: AbortSignal | undefined, message?: string) {
  if (signal?.aborted) {
    throw createAbortError(message)
  }
}
