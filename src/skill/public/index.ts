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
export {
  getBuiltinSkillsDirectory,
  materializeBuiltinSkills,
  type BuiltinSkillManifest,
  type BuiltinSkillManifestFile,
  type BuiltinSkillManifestPackage,
  type MaterializeBuiltinSkillsInput,
  type MaterializeBuiltinSkillsResult,
} from "../infrastructure/builtin-materializer"

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
