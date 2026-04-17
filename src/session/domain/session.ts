export const DEFAULT_SESSION_TITLE = "New session"

export const SESSION_TITLE_MAX_LENGTH = 60
export const SESSION_PREVIEW_MAX_LENGTH = 120
export const SESSION_ACTIVE_SKILLS_MAX_LENGTH = 100

export type StoredSession = {
  id: string
  directory: string
  workspaceRoot: string
  createdAt: number
  currentAgent?: string
  title: string
  updatedAt: number
  latestUserMessagePreview: string | null
  activeSkills: string[]
  parentSessionId?: string
}

export function isSubSession(session: Pick<StoredSession, "parentSessionId">) {
  return Boolean(session.parentSessionId)
}

export function buildDefaultSessionTitle() {
  return DEFAULT_SESSION_TITLE
}

export function buildSessionTitleFromUserPrompt(promptText: string) {
  return buildSessionTextPreview(promptText, SESSION_TITLE_MAX_LENGTH)
}

export function buildSessionPreviewFromUserPrompt(promptText: string) {
  return buildSessionTextPreview(promptText, SESSION_PREVIEW_MAX_LENGTH)
}

export function normalizeSessionActiveSkills(activeSkills: readonly string[] | null | undefined) {
  if (!activeSkills || activeSkills.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const normalized: string[] = []

  for (const activeSkill of activeSkills) {
    const value = activeSkill.trim()

    if (!value || seen.has(value)) {
      continue
    }

    seen.add(value)
    normalized.push(value)

    if (normalized.length >= SESSION_ACTIVE_SKILLS_MAX_LENGTH) {
      break
    }
  }

  return normalized
}

function buildSessionTextPreview(promptText: string, maxLength: number) {
  const normalized = promptText.replace(/\s+/g, " ").trim()

  if (!normalized) {
    return ""
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`
}
