import { createSkillRuntimeApi, type SkillRuntimeApi } from "../application"
import { createLayeredSkillStore } from "../infrastructure/adapters/layered-store"
import { createWorkspaceSkillStore } from "../infrastructure/adapters/workspace-store"

export * from "../application"
export {
  createLayeredSkillStore,
  getGlobalSkillsDirectory,
} from "../infrastructure/adapters/layered-store"
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

export function createLayeredSkillRuntime(input: {
  runtime?: SkillRuntimeApi
  store?: ReturnType<typeof createLayeredSkillStore>
} = {}) {
  return (
    input.runtime ??
    createSkillRuntimeApi({
      store: input.store ?? createLayeredSkillStore(),
    })
  )
}
