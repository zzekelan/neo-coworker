import type { ZodTypeAny } from "zod"

export type ToolExecutionResult = {
  output: string
}

export type ToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
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
