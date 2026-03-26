export const DEFAULT_SESSION_TITLE = "New session"

export const SESSION_TITLE_MAX_LENGTH = 60
export const SESSION_PREVIEW_MAX_LENGTH = 120

export type StoredSession = {
  id: string
  directory: string
  workspaceRoot: string
  createdAt: number
  title: string
  updatedAt: number
  latestUserMessagePreview: string | null
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
