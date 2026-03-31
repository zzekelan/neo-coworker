export type OrchestrationSkillCatalogEntry = {
  name: string
  description: string
  path: string
}

export type OrchestrationActiveSkill = {
  name: string
  instructions: string
}

export type OrchestrationLoadedSkill = OrchestrationActiveSkill & {
  path: string
}

export type OrchestrationSkillPort = {
  listCatalog(workspaceRoot: string): Promise<OrchestrationSkillCatalogEntry[]>
  loadSkill(input: {
    workspaceRoot: string
    name: string
  }): Promise<OrchestrationLoadedSkill>
}
