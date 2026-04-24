export interface AgentProfile {
  name: string
  displayName?: string
  description?: string
  tools?: string[] | ["*"]
  disallowedTools?: string[]
  permissionMode?: "default" | "restricted" | "permissive"
  model?: string
  maxTurns?: number
  systemPromptOverride?: string
  instructions?: string
  parallel?: boolean
  temperature?: number
  isPrimary?: boolean
  skills?: string[]
}
