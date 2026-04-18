export type OrchestrationAgentProfile = {
  instructions?: string
  skills?: string[]
  temperature?: number
}

export type OrchestrationAgentToolAccess = {
  allowed: boolean
  deniedMessage?: string
}

export type OrchestrationAgentProfilePort = {
  getResolvedProfile(input: {
    workspaceRoot: string
    name: string
  }): Promise<OrchestrationAgentProfile | undefined>
  checkToolAccess?(input: {
    workspaceRoot: string
    agentName: string
    toolName: string
  }): Promise<OrchestrationAgentToolAccess> | OrchestrationAgentToolAccess
}
