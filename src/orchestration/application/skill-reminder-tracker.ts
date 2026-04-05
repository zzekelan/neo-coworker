import type {
  OrchestrationActiveSkill,
  OrchestrationLoadedSkill,
  OrchestrationSkillCatalogEntry,
} from "./ports/skill"

type SkillReminderEntry = {
  kind: "catalog" | "instructions" | "recovery"
  text: string
}

type SessionSkillReminderState = {
  sentSkillNames: Set<string>
  injectedSkills: Map<string, OrchestrationLoadedSkill>
  entries: SkillReminderEntry[]
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

      state.entries.push({
        kind: "catalog",
        text: renderSkillCatalogReminder(delta),
      })

      return delta.map((skill) => skill.name)
    },
    listPendingActiveSkillNames(sessionId: string, activeSkillNames: readonly string[]) {
      const state = getSessionState(sessionStates, sessionId)
      return activeSkillNames.filter((skillName) => !state.injectedSkills.has(skillName))
    },
    injectActiveSkills(sessionId: string, skills: readonly OrchestrationLoadedSkill[]) {
      const state = getSessionState(sessionStates, sessionId)
      const freshSkills = skills.filter((skill) => !state.injectedSkills.has(skill.name))

      if (freshSkills.length === 0) {
        return []
      }

      for (const skill of freshSkills) {
        state.injectedSkills.set(skill.name, skill)
      }

      state.entries.push({
        kind: "instructions",
        text: renderActiveSkillReminder(freshSkills),
      })

      return freshSkills.map((skill) => skill.name)
    },
    appendRecoveryReminder(sessionId: string, text: string) {
      const reminder = text.trim()
      if (!reminder) {
        return
      }

      const state = getSessionState(sessionStates, sessionId)
      state.entries.push({
        kind: "recovery",
        text: reminder,
      })
    },
    resolveActiveSkills(sessionId: string, activeSkillNames: readonly string[]): OrchestrationActiveSkill[] {
      const state = getSessionState(sessionStates, sessionId)
      return activeSkillNames.flatMap((skillName) => {
        const skill = state.injectedSkills.get(skillName)
        return skill ? [{ name: skill.name, instructions: skill.instructions }] : []
      })
    },
    buildSystemReminders(sessionId: string) {
      const state = getSessionState(sessionStates, sessionId)
      if (
        state.entries.length === 0 &&
        state.sentSkillNames.size === 0 &&
        state.injectedSkills.size === 0
      ) {
        return undefined
      }
      return state.entries.map((entry) => entry.text)
    },
    resetAfterCompaction(sessionId: string) {
      const state = getSessionState(sessionStates, sessionId)
      state.injectedSkills.clear()
      state.entries = []
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
    entries: [],
  }
  sessionStates.set(sessionId, created)
  return created
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
