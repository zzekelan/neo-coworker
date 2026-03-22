import {
  createToolProviderFromRuntime,
  type ToolTelemetryPort,
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
  telemetry?: ToolTelemetryPort
}): ToolProvider {
  const runtime =
    input.runtime ??
    createBuiltinToolRuntime({
      requestPermission: input.requestPermission,
    })

  return createToolProviderFromRuntime({
    runtime,
    telemetry: input.telemetry,
  })
}
