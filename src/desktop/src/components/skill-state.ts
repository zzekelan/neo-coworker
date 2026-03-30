import type { DesktopRun, DesktopSession, DesktopSkillCatalogEntry } from "../view-types"

export type SkillActionState = {
  canStart: boolean
  canStop: boolean
  canSetDefault: boolean
  isActive: boolean
  isDefault: boolean
}

export function filterSkillCatalog(
  skills: DesktopSkillCatalogEntry[],
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return skills
  }

  return skills.filter((skill) =>
    [skill.name, skill.description, skill.path].some((field) =>
      field.toLowerCase().includes(normalizedQuery),
    ),
  )
}

export function getEffectiveActiveSkills(input: {
  session: DesktopSession | null
  activeRun?: DesktopRun
}) {
  if (input.activeRun) {
    return input.activeRun.activeSkills
  }

  return input.session?.activeSkills ?? []
}

export function getSkillActionState(input: {
  skillName: string
  session: DesktopSession | null
  activeRun?: DesktopRun
}) {
  const effectiveActiveSkills = getEffectiveActiveSkills(input)
  const defaultSkills = input.session?.activeSkills ?? []
  const isActive = effectiveActiveSkills.includes(input.skillName)
  const isDefault = defaultSkills.includes(input.skillName)

  const state: SkillActionState = {
    canStart: !isActive,
    canStop: isActive,
    canSetDefault: Boolean(input.activeRun) && isActive && !isDefault,
    isActive,
    isDefault,
  }

  return state
}

export function toggleSkill(input: {
  skills: string[]
  skillName: string
  enabled: boolean
}) {
  if (input.enabled) {
    return input.skills.includes(input.skillName)
      ? input.skills
      : [...input.skills, input.skillName]
  }

  return input.skills.filter((skill) => skill !== input.skillName)
}
