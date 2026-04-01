const { contextBridge, ipcRenderer } = require("electron")

const BRIDGE_STATE = {
  defaultWorkspaceRoot: readArgument("--neo-coworker-default-workspace-root="),
  platform: readArgument("--neo-coworker-platform=") ?? process.platform,
  persistedWorkspaceRoot: readArgument("--neo-coworker-persisted-workspace-root="),
  persistedSessionId: readArgument("--neo-coworker-persisted-session-id="),
  serverMode: readArgument("--neo-coworker-server-mode="),
}

contextBridge.exposeInMainWorld("neoCoworkerDesktop", {
  ...BRIDGE_STATE,
  pickDirectory() {
    return ipcRenderer.invoke("neo-coworker:pick-directory")
  },
  requestJson(input) {
    return ipcRenderer.invoke("neo-coworker:request-json", input)
  },
  persistSelection(input) {
    return ipcRenderer.invoke("neo-coworker:persist-selection", input)
  },
  loadDesktopSettings() {
    return ipcRenderer.invoke("neo-coworker:load-settings")
  },
  saveDesktopSettings(input) {
    return ipcRenderer.invoke("neo-coworker:save-settings", input)
  },
  applyDesktopSettings(input) {
    return ipcRenderer.invoke("neo-coworker:apply-settings", input)
  },
})

ipcRenderer.on("neo-coworker:event", (_event, payload) => {
  window.dispatchEvent(new CustomEvent("neo-coworker:event", { detail: payload }))
})

ipcRenderer.on("neo-coworker:event-error", (_event, detail) => {
  window.dispatchEvent(new CustomEvent("neo-coworker:event-error", { detail }))
})

function readArgument(prefix) {
  const argument = process.argv.find((value) => value.startsWith(prefix))
  if (!argument) {
    return undefined
  }

  return decodeURIComponent(argument.slice(prefix.length))
}
