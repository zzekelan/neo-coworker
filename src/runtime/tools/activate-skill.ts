import { z } from "zod"
import { resolveSkillFile, type ActiveSkill } from "../skills/catalog"
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
      const file = await resolveSkillFile(toolInput.workspaceRoot, name)
      const instructions = await Bun.file(file).text()

      input.activeSkills.push({ name, instructions })

      return { output: `Activated skill ${name}` }
    },
  }
}
