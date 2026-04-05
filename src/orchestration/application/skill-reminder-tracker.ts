import type {
  OrchestrationActiveSkill,
  OrchestrationLoadedSkill,
  OrchestrationSkillCatalogEntry,
} from "./ports/skill"
import { countTokens } from "gpt-tokenizer/model/gpt-4o"

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

      const skillsToInject =
        input.reason === "recovery"
          ? truncateRecoverySkills(freshSkills)
          : freshSkills

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
        return skill ? [{ name: skill.name, instructions: skill.instructions }] : []
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
    ...skillCatalog.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`),
    "</system-reminder>",
  ].join("\n")
}

function renderActiveSkillReminder(activeSkills: readonly OrchestrationActiveSkill[]) {
  return [
    "<system-reminder>",
    "Active skill instructions:",
    "",
    ...activeSkills.map((skill) => `## ${skill.name}\n${skill.instructions}`),
    "</system-reminder>",
  ].join("\n")
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
