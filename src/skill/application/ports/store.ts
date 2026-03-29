export type SkillCatalogEntry = {
  name: string
  description: string
  path: string
}

export type LoadedSkill = SkillCatalogEntry & {
  instructions: string
}

export type SkillStore = {
  listCatalog(workspaceRoot: string): Promise<SkillCatalogEntry[]>
  loadByPath(workspaceRoot: string, skillPath: string): Promise<LoadedSkill>
  loadByName(workspaceRoot: string, skillName: string): Promise<LoadedSkill>
}
