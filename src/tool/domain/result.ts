export type ToolExecutionResult = {
  output: string
  isError?: boolean
  metadata?: Record<string, unknown>
}

export type ToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}
