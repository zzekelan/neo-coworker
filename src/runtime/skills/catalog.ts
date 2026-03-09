import { realpath } from "node:fs/promises"
import { resolve, sep } from "node:path"

export const SKILLS_DIRECTORY = ".agents/skills"
export const SKILL_FILENAME = "SKILL.md"
const SKILL_METADATA_BYTES = 2048

export type SkillCatalogEntry = {
  name: string
  description: string
  path: string
}

export type ActiveSkill = {
  name: string
  instructions: string
}

export function getSkillsDirectory(workspaceRoot: string) {
  return resolve(workspaceRoot, SKILLS_DIRECTORY)
}

export function getSkillCatalogPath(skillName: string) {
  return `${SKILLS_DIRECTORY}/${skillName}/${SKILL_FILENAME}`
}

export function parseSkillMetadata(text: string, fallbackName: string) {
  return {
    name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? fallbackName,
    description:
      text.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "No description provided",
  }
}

export async function resolveSkillFile(workspaceRoot: string, skillName: string) {
  return await resolveSkillCatalogPath(workspaceRoot, getSkillCatalogPath(skillName))
}

export async function resolveSkillCatalogPath(workspaceRoot: string, skillPath: string) {
  const workspace = await realpath(resolve(workspaceRoot))
  const skillsRoot = resolve(workspace, SKILLS_DIRECTORY)
  const file = await realpath(resolve(workspace, skillPath))

  if (file !== skillsRoot && !file.startsWith(`${skillsRoot}${sep}`)) {
    throw new Error(`Skill must stay inside ${SKILLS_DIRECTORY}: ${skillPath}`)
  }

  return file
}

export async function readSkillMetadata(
  workspaceRoot: string,
  skillPath: string,
  fallbackName: string,
) {
  const file = await resolveSkillCatalogPath(workspaceRoot, skillPath)
  const text = await Bun.file(file).slice(0, SKILL_METADATA_BYTES).text()

  return parseSkillMetadata(text, fallbackName)
}
