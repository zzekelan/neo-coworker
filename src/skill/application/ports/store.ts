export type SkillCatalogEntry = {
  name: string
  description: string
  path: string
}

export type SkillSource = "builtin" | "global" | "workspace"

export type SkillPackageMetadata = {
  entryPath: string
  baseDir: string
  source: SkillSource
  files: string[]
}

export type LoadedSkill = SkillCatalogEntry & {
  instructions: string
} & SkillPackageMetadata

export type SkillStore = {
  listCatalog(workspaceRoot: string): Promise<SkillCatalogEntry[]>
  loadByPath(workspaceRoot: string, skillPath: string): Promise<LoadedSkill>
  loadByName(workspaceRoot: string, skillName: string): Promise<LoadedSkill>
  writeSkill(workspaceRoot: string, skillPath: string, content: string): Promise<void>
  deleteSkill(workspaceRoot: string, skillPath: string): Promise<void>
}
