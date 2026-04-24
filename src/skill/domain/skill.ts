export const SKILLS_DIRECTORY = ".ncoworker/skills"
export const SKILL_FILENAME = "SKILL.md"
export const SKILL_METADATA_BYTES = 2048

export function getSkillCatalogPath(skillName: string, skillsDirectory = SKILLS_DIRECTORY) {
  return `${skillsDirectory}/${skillName}/${SKILL_FILENAME}`
}

export function parseSkillMetadata(text: string, fallbackName: string) {
  return {
    name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? fallbackName,
    description:
      text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "No description provided",
  }
}
