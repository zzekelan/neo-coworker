export type OrchestrationSkillCatalogEntry = {
  name: string
  description: string
  path: string
  source?: OrchestrationSkillSource
  overrides?: OrchestrationSkillCatalogOverride[]
}

export type OrchestrationSkillSource = "builtin" | "global" | "workspace"

export type OrchestrationSkillCatalogOverride = {
  source: OrchestrationSkillSource
  path: string
}

export type OrchestrationSkillPackageMetadata = {
  entryPath?: string
  baseDir?: string
  source?: OrchestrationSkillSource
  files?: string[]
}

export type OrchestrationActiveSkill = OrchestrationSkillPackageMetadata & {
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
