import { contextBridge, ipcRenderer } from "electron"

const BRIDGE_STATE = {
  defaultWorkspaceRoot: readArgument("--neo-coworker-default-workspace-root="),
  platform: readArgument("--neo-coworker-platform=") ?? process.platform,
}

contextBridge.exposeInMainWorld("neoCoworkerDesktop", {
  ...BRIDGE_STATE,
  requestJson(input) {
    return ipcRenderer.invoke("neo-coworker:request-json", input)
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
