import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from "./desktop-settings"
import "./index.css"

const BROWSER_SELECTION_STORAGE_KEY = "neo-coworker.browser.selection"
const BROWSER_SETTINGS_STORAGE_KEY = "neo-coworker.browser.settings"

if (!window.neoCoworkerDesktop) {
  const persistedSelection = readBrowserSelection()
  const persistedSettings = readBrowserSettings()

  // In browser mode, Vite proxies API and SSE requests to the local app-server.
  window.neoCoworkerDesktop = {
    apiOrigin: window.location.origin,
    platform: navigator.platform,
    serverMode: "external",
    persistedWorkspaceRoot: persistedSelection.activeWorkspaceRoot ?? undefined,
    persistedSessionId: persistedSelection.activeSessionId ?? undefined,
    async pickDirectory() {
      const value = window.prompt("Enter the workspace directory path")
      return value?.trim() || null
    },
    async persistSelection(input) {
      writeBrowserSelection(input)
      window.neoCoworkerDesktop = {
        ...window.neoCoworkerDesktop,
        persistedWorkspaceRoot: input.activeWorkspaceRoot ?? undefined,
        persistedSessionId: input.activeSessionId ?? undefined,
      }
      return true
    },
    async loadDesktopSettings() {
      return {
        settings: persistedSettings,
        serverMode: "external",
      }
    },
    async saveDesktopSettings(input) {
      const normalized = writeBrowserSettings(input)
      return {
        settings: normalized,
        serverMode: "external",
      }
    },
    async applyDesktopSettings(input) {
      const normalized = writeBrowserSettings(input)
      return {
        settings: normalized,
        serverMode: "external",
        restarted: false,
      }
    },
  }
}

const root = document.getElementById("root")

if (!root) {
  throw new Error("Missing root element")
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

function readBrowserSelection() {
  try {
    const rawValue = window.localStorage.getItem(BROWSER_SELECTION_STORAGE_KEY)
    if (!rawValue) {
      return {
        activeWorkspaceRoot: null,
        activeSessionId: null,
      }
    }

    const parsedValue = JSON.parse(rawValue)
    return {
      activeWorkspaceRoot:
        typeof parsedValue.activeWorkspaceRoot === "string" ? parsedValue.activeWorkspaceRoot : null,
      activeSessionId: typeof parsedValue.activeSessionId === "string" ? parsedValue.activeSessionId : null,
    }
  } catch {
    return {
      activeWorkspaceRoot: null,
      activeSessionId: null,
    }
  }
}

function writeBrowserSelection(input: { activeWorkspaceRoot: string | null; activeSessionId: string | null }) {
  try {
    window.localStorage.setItem(BROWSER_SELECTION_STORAGE_KEY, JSON.stringify(input))
  } catch {
    // Ignore browser storage failures and keep the in-memory selection usable.
  }
}

function readBrowserSettings(): DesktopSettings {
  try {
    const rawValue = window.localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY)
    if (!rawValue) {
      return {
        ...DEFAULT_DESKTOP_SETTINGS,
      }
    }

    const parsedValue = JSON.parse(rawValue)
    return normalizeBrowserSettings(parsedValue)
  } catch {
    return {
      ...DEFAULT_DESKTOP_SETTINGS,
    }
  }
}

function writeBrowserSettings(input: DesktopSettings) {
  const normalized = normalizeBrowserSettings(input)

  try {
    window.localStorage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Ignore browser storage failures and keep the in-memory settings usable.
  }

  return normalized
}

function normalizeBrowserSettings(value: unknown): DesktopSettings {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_DESKTOP_SETTINGS,
    }
  }

  const candidate = value as Record<string, unknown>

  return {
    language: candidate.language === "zh" ? "zh" : "en",
    theme:
      candidate.theme === "dark" || candidate.theme === "light"
        ? candidate.theme
        : DEFAULT_DESKTOP_SETTINGS.theme,
    provider:
      candidate.provider === "openai-compatible"
        ? "openai-compatible"
        : candidate.provider === "openai"
          ? "openai"
          : "",
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    model:
      typeof candidate.model === "string" && candidate.model.trim().length > 0
        ? candidate.model.trim()
        : DEFAULT_DESKTOP_SETTINGS.model,
    baseURL: typeof candidate.baseURL === "string" ? candidate.baseURL.trim() : "",
    timeoutMs:
      typeof candidate.timeoutMs === "string" && /^\d*$/.test(candidate.timeoutMs.trim())
        ? candidate.timeoutMs.trim()
        : "",
    thinkingEnabled:
      typeof candidate.thinkingEnabled === "boolean"
        ? candidate.thinkingEnabled
        : DEFAULT_DESKTOP_SETTINGS.thinkingEnabled,
    reasoningEffortMode:
      candidate.reasoningEffortMode === "low"
        || candidate.reasoningEffortMode === "medium"
        || candidate.reasoningEffortMode === "high"
        || candidate.reasoningEffortMode === "default"
        ? candidate.reasoningEffortMode
        : DEFAULT_DESKTOP_SETTINGS.reasoningEffortMode,
  }
}
