import type { ZodTypeAny } from "zod"

export type OrchestrationTool = {
  name: string
  description: string
  inputSchema?: ZodTypeAny
}

export type OrchestrationToolExecutionInput = {
  toolName: string
  args: unknown
  workspaceRoot: string
  signal?: AbortSignal
}

export type OrchestrationToolExecutionResult = {
  output: string
}

export type OrchestrationToolPort = {
  list(): OrchestrationTool[]
  execute(
    input: OrchestrationToolExecutionInput,
  ): Promise<OrchestrationToolExecutionResult> | OrchestrationToolExecutionResult
}
