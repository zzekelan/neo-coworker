import type {
  OrchestrationActiveSkill,
  OrchestrationLoadedSkill,
  OrchestrationSkillCatalogEntry,
} from "./ports/skill"
import { countTokens } from "gpt-tokenizer/model/gpt-4o"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

const MAX_SKILL_RECOVERY_TOKENS = 25_000
const MAX_TOKENS_PER_SKILL = 5_000
const TRUNCATION_MARKER = "\n...[truncated]"

type SkillReminderEntry = {
  kind: "catalog" | "instructions" | "recovery"
  text: string
  skillNames?: string[]
  filePaths?: string[]
}

export type SkillReminderBatch = {
  messages: string[] | undefined
  catalogSkillNames: string[]
  activeSkillNames: string[]
  recoveryFilePaths: string[]
}

type SessionSkillReminderState = {
  sentSkillNames: Set<string>
  injectedSkills: Map<string, OrchestrationLoadedSkill>
  pendingEntries: SkillReminderEntry[]
}

export function createSkillReminderTracker() {
  const sessionStates = new Map<string, SessionSkillReminderState>()

  return {
    exposeCatalog(sessionId: string, catalog: OrchestrationSkillCatalogEntry[]) {
      const state = getSessionState(sessionStates, sessionId)
      const delta = catalog.filter((skill) => !state.sentSkillNames.has(skill.name))

      if (delta.length === 0) {
        return []
      }

      for (const skill of delta) {
        state.sentSkillNames.add(skill.name)
      }

      state.pendingEntries.push({
        kind: "catalog",
        text: renderSkillCatalogReminder(delta),
        skillNames: delta.map((skill) => skill.name),
      })

      return delta.map((skill) => skill.name)
    },
    listPendingActiveSkillNames(sessionId: string, activeSkillNames: readonly string[]) {
      const state = getSessionState(sessionStates, sessionId)
      return activeSkillNames.filter((skillName) => !state.injectedSkills.has(skillName))
    },
    injectActiveSkills(input: {
      sessionId: string
      skills: readonly OrchestrationLoadedSkill[]
      reason: "prompt" | "recovery"
    }) {
      const state = getSessionState(sessionStates, input.sessionId)
      const freshSkills = input.skills.filter((skill) => !state.injectedSkills.has(skill.name))

      if (freshSkills.length === 0) {
        return []
      }

      const skillsToInject = input.reason === "recovery" ? truncateRecoverySkills(freshSkills) : freshSkills

      if (skillsToInject.length === 0) {
        return []
      }

      for (const skill of skillsToInject) {
        state.injectedSkills.set(skill.name, skill)
      }

      state.pendingEntries.push({
        kind: "instructions",
        text: renderActiveSkillReminder(skillsToInject),
        skillNames: skillsToInject.map((skill) => skill.name),
      })

      return skillsToInject.map((skill) => skill.name)
    },
    appendRecoveryReminder(input: {
      sessionId: string
      text: string
      filePaths: readonly string[]
    }) {
      const reminder = input.text.trim()
      if (!reminder || input.filePaths.length === 0) {
        return
      }

      const state = getSessionState(sessionStates, input.sessionId)
      state.pendingEntries.push({
        kind: "recovery",
        text: reminder,
        filePaths: [...input.filePaths],
      })
    },
    resolveActiveSkills(sessionId: string, activeSkillNames: readonly string[]): OrchestrationActiveSkill[] {
      const state = getSessionState(sessionStates, sessionId)
      return activeSkillNames.flatMap((skillName) => {
        const skill = state.injectedSkills.get(skillName)
        return skill ? [toActiveSkill(skill)] : []
      })
    },
    peekSystemReminderBatch(sessionId: string): SkillReminderBatch | undefined {
      const state = getSessionState(sessionStates, sessionId)
      return buildSystemReminderBatch(state.pendingEntries)
    },
    consumeSystemReminderBatch(sessionId: string): SkillReminderBatch | undefined {
      const state = getSessionState(sessionStates, sessionId)
      const batch = buildSystemReminderBatch(state.pendingEntries)
      state.pendingEntries = []
      return batch
    },
    resetAfterCompaction(sessionId: string) {
      const state = getSessionState(sessionStates, sessionId)
      state.injectedSkills.clear()
      state.pendingEntries = []
    },
  }
}

function toActiveSkill(skill: OrchestrationLoadedSkill): OrchestrationActiveSkill {
  return {
    name: skill.name,
    instructions: skill.instructions,
    ...(skill.entryPath !== undefined && { entryPath: skill.entryPath }),
    ...(skill.baseDir !== undefined && { baseDir: skill.baseDir }),
    ...(skill.source !== undefined && { source: skill.source }),
    ...(skill.files !== undefined && { files: skill.files }),
  }
}

function getSessionState(
  sessionStates: Map<string, SessionSkillReminderState>,
  sessionId: string,
): SessionSkillReminderState {
  const existing = sessionStates.get(sessionId)
  if (existing) {
    return existing
  }

  const created: SessionSkillReminderState = {
    sentSkillNames: new Set<string>(),
    injectedSkills: new Map<string, OrchestrationLoadedSkill>(),
    pendingEntries: [],
  }
  sessionStates.set(sessionId, created)
  return created
}

function buildSystemReminderBatch(entries: readonly SkillReminderEntry[]): SkillReminderBatch | undefined {
  if (entries.length === 0) {
    return undefined
  }

  return {
    messages: entries.map((entry) => entry.text),
    catalogSkillNames: [...new Set(entries.flatMap((entry) => entry.kind === "catalog" ? (entry.skillNames ?? []) : []))],
    activeSkillNames: [...new Set(entries.flatMap((entry) => entry.kind === "instructions" ? (entry.skillNames ?? []) : []))],
    recoveryFilePaths: [...new Set(entries.flatMap((entry) => entry.kind === "recovery" ? (entry.filePaths ?? []) : []))],
  }
}

function renderSkillCatalogReminder(skillCatalog: OrchestrationSkillCatalogEntry[]) {
  return [
    "<system-reminder>",
    "Skill catalog:",
    ...skillCatalog.map((skill) => `- ${formatSkillCatalogEntry(skill)} (${skill.path})`),
    "</system-reminder>",
  ].join("\n")
}

function formatSkillCatalogEntry(skill: OrchestrationSkillCatalogEntry) {
  const metadata = [
    skill.source ? `source: ${skill.source}` : null,
    skill.overrides && skill.overrides.length > 0
      ? `overrides: ${skill.overrides.map((entry) => `${entry.source} ${entry.path}`).join(", ")}`
      : null,
  ].filter((entry): entry is string => entry !== null)

  return metadata.length > 0
    ? `${skill.name}: ${skill.description} [${metadata.join("; ")}]`
    : `${skill.name}: ${skill.description}`
}

function renderActiveSkillReminder(activeSkills: readonly OrchestrationActiveSkill[]) {
  return [
    "<system-reminder>",
    "Active skill instructions:",
    "",
    ...activeSkills.map(renderActiveSkill),
    "</system-reminder>",
  ].join("\n")
}

function renderActiveSkill(skill: OrchestrationActiveSkill) {
  return [`## ${skill.name}`, skill.instructions, renderSkillPackageFiles(skill)].filter(
    (section): section is string => section !== null,
  ).join("\n")
}

function renderSkillPackageFiles(skill: OrchestrationActiveSkill) {
  if (!skill.files || skill.files.length === 0) {
    return null
  }

  const baseDirPath = resolveReadableBaseDir(skill.baseDir)
  return [
    "Package files available on demand:",
    "When instructions mention one of these package files, call the read tool with the exact absolute Read path shown below.",
    ...skill.files.map((file) => {
      const readPath = baseDirPath ? ` (Read path: ${join(baseDirPath, file)})` : ""
      return `- ${file}${readPath}`
    }),
  ].join("\n")
}

function resolveReadableBaseDir(baseDir: string | undefined) {
  if (!baseDir) {
    return null
  }

  if (baseDir.startsWith("file://")) {
    return fileURLToPath(baseDir)
  }

  return isAbsolute(baseDir) ? baseDir : null
}

function truncateRecoverySkills(skills: readonly OrchestrationLoadedSkill[]) {
  const selected: OrchestrationLoadedSkill[] = []
  let remainingTokens = MAX_SKILL_RECOVERY_TOKENS

  for (const skill of skills) {
    const truncatedInstructions = truncateToTokenLimit(skill.instructions, MAX_TOKENS_PER_SKILL)
    const tokenCount = countTokens(truncatedInstructions)

    if (tokenCount > remainingTokens) {
      break
    }

    selected.push({
      ...skill,
      instructions: truncatedInstructions,
    })
    remainingTokens -= tokenCount
  }

  return selected
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) {
    return text
  }

  let low = 0
  let high = text.length
  let best = ""

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = `${text.slice(0, middle).trimEnd()}${TRUNCATION_MARKER}`
    if (countTokens(candidate) <= maxTokens) {
      best = candidate
      low = middle + 1
      continue
    }

    high = middle - 1
  }

  return best || text.slice(0, Math.max(0, high)).trimEnd()
}
