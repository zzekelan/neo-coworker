import { getSkillCatalogPath, SKILL_FILENAME } from "../domain"
import type { SkillCatalogEntry, SkillStore } from "./ports/store"

function matchesRequestedSkillPath(skillPath: string, skillName: string) {
  const workspaceCatalogPath = getSkillCatalogPath(skillName)
  const packageCatalogPath = `${skillName}/${SKILL_FILENAME}`

  return (
    skillPath === workspaceCatalogPath ||
    skillPath === packageCatalogPath ||
    skillPath.endsWith(`:${packageCatalogPath}`)
  )
}

function matchesRequestedSkill(entry: SkillCatalogEntry, skillName: string) {
  return (
    entry.name === skillName ||
    matchesRequestedSkillPath(entry.path, skillName) ||
    (entry.overrides ?? []).some((override) => matchesRequestedSkillPath(override.path, skillName))
  )
}

export type CreateSkillRuntimeApiInput = {
  store: SkillStore
}

export function createSkillRuntimeApi(input: CreateSkillRuntimeApiInput) {
  return {
    listCatalog(workspaceRoot: string) {
      return input.store.listCatalog(workspaceRoot)
    },
    async loadSkill(inputValue: {
      workspaceRoot: string
      name: string
    }) {
      const catalog = await input.store.listCatalog(inputValue.workspaceRoot)
      const discoveredSkill = catalog.find((skill) => matchesRequestedSkill(skill, inputValue.name))

      if (discoveredSkill) {
        return input.store.loadByPath(inputValue.workspaceRoot, discoveredSkill.path)
      }

      return input.store.loadByName(inputValue.workspaceRoot, inputValue.name)
    },
  }
}

export type SkillRuntimeApi = ReturnType<typeof createSkillRuntimeApi>
