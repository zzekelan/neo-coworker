export type ToolExecutionResult = {
  output: string
}

export type ToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
  signal?: AbortSignal
}
