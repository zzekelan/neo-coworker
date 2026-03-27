import {
  type CreateToolProviderScope,
  type BuiltinResearchToolCallbacks,
  type ToolObserverPort,
  createToolProviderFromRuntime,
  type ToolProvider,
  type ToolRuntimeApi,
} from "../application"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runtime/create-builtin-runtime"

export * from "../application"
export {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runtime/create-builtin-runtime"
export { createActivateSkillTool } from "../infrastructure/builtins/activate-skill"
export { createEditTool } from "../infrastructure/builtins/edit"
export { createReadTool } from "../infrastructure/builtins/read"
export {
  createResearchListAssetsTool,
  createResearchReadAssetTool,
  createResearchSearchAssetsTool,
  createResearchWriteAssetTool,
  createWebFetchTool,
} from "../infrastructure/builtins/research"
export { createSearchTool } from "../infrastructure/builtins/search"
export { createShellTool } from "../infrastructure/builtins/shell"
export { createWriteTool } from "../infrastructure/builtins/write"
export { discoverSkills } from "../infrastructure/builtins/skills/discover"
export {
  getSkillCatalogPath,
  getSkillsDirectory,
  parseSkillMetadata,
  resolveSkillCatalogPath,
  resolveSkillFile,
  readSkillMetadata,
  SKILLS_DIRECTORY,
  SKILL_FILENAME,
  type ActiveSkill,
  type SkillCatalogEntry,
} from "../infrastructure/builtins/skills/catalog"

export function createToolProvider(input: {
  runtime?: ToolRuntimeApi
  requestPermission?: CreateBuiltinToolRuntimeInput["requestPermission"]
  research?: BuiltinResearchToolCallbacks
  observer?: ToolObserverPort
  scope?: CreateToolProviderScope
}): ToolProvider {
  const runtime =
    input.runtime ??
    createBuiltinToolRuntime({
      requestPermission: input.requestPermission,
      research: input.research,
    })

  return createToolProviderFromRuntime({
    runtime,
    observer: input.observer,
    scope: input.scope,
  })
}
