import type { AgentProfile } from "../domain/agent-profile"
import type {
  AgentLoadedSkill,
  AgentSkillPort,
  AgentToolDefinition,
} from "./ports/sub-agent-runtime"

const ALWAYS_EXCLUDED_TOOLS = new Set(["agent", "skill", "plan_exit"])

export function filterToolsForAgent(
  parentTools: AgentToolDefinition[],
  profile: AgentProfile,
): AgentToolDefinition[] {
  const base = parentTools.filter((tool) => !ALWAYS_EXCLUDED_TOOLS.has(tool.name))

  if (!profile.tools || profile.tools.length === 0 || profile.tools[0] === "*") {
    return applyDisallowed(base, profile.disallowedTools)
  }

  const allowed = new Set(profile.tools)
  return applyDisallowed(
    base.filter((tool) => allowed.has(tool.name)),
    profile.disallowedTools,
  )
}

export async function loadSkillsForAgent(
  profile: AgentProfile,
  parentSkillService: AgentSkillPort,
): Promise<AgentToolDefinition[]> {
  const skillNames = [...new Set((profile.skills ?? []).filter((skill) => skill.trim().length > 0))]
  if (skillNames.length === 0) {
    return []
  }

  const loadedSkills = await Promise.all(
    skillNames.map((name) =>
      parentSkillService.loadSkill({
        workspaceRoot: "",
        name,
      }),
    ),
  )

  return dedupeToolsByName(loadedSkills.flatMap(readInjectedTools))
}

function applyDisallowed(tools: AgentToolDefinition[], disallowed?: string[]) {
  if (!disallowed || disallowed.length === 0) {
    return tools
  }

  const disallowedSet = new Set(disallowed)
  return tools.filter((tool) => !disallowedSet.has(tool.name))
}

function readInjectedTools(skill: AgentLoadedSkill): AgentToolDefinition[] {
  const extendedSkill = skill as AgentLoadedSkill & {
    injectedTools?: AgentToolDefinition[]
    tools?: AgentToolDefinition[]
  }

  return extendedSkill.injectedTools ?? extendedSkill.tools ?? []
}

function dedupeToolsByName(tools: AgentToolDefinition[]) {
  const byName = new Map<string, AgentToolDefinition>()

  for (const tool of tools) {
    byName.set(tool.name, tool)
  }

  return [...byName.values()]
}
