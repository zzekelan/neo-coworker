import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./index.css"

const BROWSER_SELECTION_STORAGE_KEY = "neo-coworker.browser.selection"

if (!window.neoCoworkerDesktop) {
  const persistedSelection = readBrowserSelection()

  // In browser mode, Vite proxies API and SSE requests to the local app-server.
  window.neoCoworkerDesktop = {
    apiOrigin: window.location.origin,
    platform: navigator.platform,
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
