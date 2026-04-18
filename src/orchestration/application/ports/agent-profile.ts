export type OrchestrationAgentProfile = {
  instructions?: string
}

export type OrchestrationAgentProfilePort = {
  getResolvedProfile(input: {
    workspaceRoot: string
    name: string
  }): Promise<OrchestrationAgentProfile | undefined>
}
