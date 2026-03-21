import {
  createToolProviderFromRuntime,
  type ToolTelemetryPort,
  type ToolProvider,
  type ToolRuntimeApi,
} from "../application"
import {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runner"

export * from "../application"
export {
  createBuiltinToolRuntime,
  type CreateBuiltinToolRuntimeInput,
} from "../infrastructure/runner"
export { createActivateSkillTool } from "../infrastructure/activate-skill"
export { createEditTool } from "../infrastructure/edit"
export { createReadTool } from "../infrastructure/read"
export { createSearchTool } from "../infrastructure/search"
export { createShellTool } from "../infrastructure/shell"
export { createWriteTool } from "../infrastructure/write"
export { discoverSkills } from "../infrastructure/skills/discover"
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
} from "../infrastructure/skills/catalog"

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
