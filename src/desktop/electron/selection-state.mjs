import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export function readDesktopSelectionState(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8")
    return normalizeDesktopSelectionState(JSON.parse(raw))
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null
    if (code === "ENOENT") {
      return null
    }

    return null
  }
}

export function writeDesktopSelectionState(filePath, selection) {
  const normalized = normalizeDesktopSelectionState(selection)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(normalized, null, 2))
}

function normalizeDesktopSelectionState(value) {
  if (!value || typeof value !== "object") {
    return {
      activeProjectRoot: null,
      activeSessionId: null,
    }
  }

  return {
    activeProjectRoot:
      typeof value.activeProjectRoot === "string" && value.activeProjectRoot.length > 0
        ? value.activeProjectRoot
        : null,
    activeSessionId:
      typeof value.activeSessionId === "string" && value.activeSessionId.length > 0
        ? value.activeSessionId
        : null,
  }
}
