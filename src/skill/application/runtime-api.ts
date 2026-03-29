import { getSkillCatalogPath } from "../domain"
import type { SkillStore } from "./ports/store"

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
      const discoveredSkill =
        catalog.find((skill) => skill.name === inputValue.name) ??
        catalog.find((skill) => skill.path === getSkillCatalogPath(inputValue.name))

      if (discoveredSkill) {
        return input.store.loadByPath(inputValue.workspaceRoot, discoveredSkill.path)
      }

      return input.store.loadByName(inputValue.workspaceRoot, inputValue.name)
    },
  }
}

export type SkillRuntimeApi = ReturnType<typeof createSkillRuntimeApi>
