import { z } from "zod"
import { discoverSkills } from "../skills/discover"
import {
  getSkillCatalogPath,
  resolveSkillCatalogPath,
  resolveSkillFile,
  type ActiveSkill,
} from "../skills/catalog"
import type { ToolDefinition } from "./types"

const ActivateSkillArgsSchema = z.object({
  name: z.string().min(1),
})

export function createActivateSkillTool(input: {
  activeSkills: ActiveSkill[]
}): ToolDefinition {
  return {
    name: "activate_skill",
    description: "Load a skill by name and add its instructions to runtime context",
    inputSchema: ActivateSkillArgsSchema,
    async execute(toolInput) {
      const { name } = ActivateSkillArgsSchema.parse(toolInput.args)
      const catalog = await discoverSkills(toolInput.workspaceRoot)
      const discoveredSkill =
        catalog.find((skill) => skill.name === name) ??
        catalog.find((skill) => skill.path === getSkillCatalogPath(name))
      const file = discoveredSkill
        ? await resolveSkillCatalogPath(toolInput.workspaceRoot, discoveredSkill.path)
        : await resolveSkillFile(toolInput.workspaceRoot, name)
      const activeName = discoveredSkill?.name ?? name
      const instructions = await Bun.file(file).text()

      input.activeSkills.push({ name: activeName, instructions })

      return { output: `Activated skill ${activeName}` }
    },
  }
}
