import { createSkillRuntimeApi, type SkillRuntimeApi } from "../application"
import { createWorkspaceSkillStore } from "../infrastructure/adapters/workspace-store"

export * from "../application"
export {
  createWorkspaceSkillStore,
  getSkillsDirectory,
  readSkillMetadata,
  resolveSkillCatalogPath,
  resolveSkillFile,
} from "../infrastructure/adapters/workspace-store"

export function createWorkspaceSkillRuntime(input: {
  runtime?: SkillRuntimeApi
} = {}) {
  return (
    input.runtime ??
    createSkillRuntimeApi({
      store: createWorkspaceSkillStore(),
    })
  )
}
