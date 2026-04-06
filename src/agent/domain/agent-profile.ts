export interface AgentProfile {
  name: string
  description?: string
  tools?: string[] | ["*"]
  disallowedTools?: string[]
  permissionMode?: "default" | "restricted" | "permissive"
  model?: string
  maxTurns?: number
  systemPromptOverride?: string
  instructions?: string
  parallel?: boolean
  skills?: string[]
}
