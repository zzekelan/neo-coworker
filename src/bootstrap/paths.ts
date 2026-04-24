import { homedir } from "os"
import { isAbsolute, join } from "path"

const APP_DIR_NAME = "neo-coworker"

// Tracks warnings emitted to avoid duplicate console.warn
const warnedPaths = new Set<string>()

function resolveXdgBase(envName: "XDG_CONFIG_HOME" | "XDG_DATA_HOME", fallback: string): string {
  const value = process.env[envName]
  if (value && isAbsolute(value)) {
    return value
  }
  return fallback
}

export function getUserConfigRoot(): string {
  return join(resolveXdgBase("XDG_CONFIG_HOME", join(homedir(), ".config")), APP_DIR_NAME)
}

export function getUserDataRoot(): string {
  return join(resolveXdgBase("XDG_DATA_HOME", join(homedir(), ".local", "share")), APP_DIR_NAME)
}

export function getAppStateRoot(): string {
  return getUserDataRoot()
}

export function getConfigDir(_workspaceRoot?: string): string {
  return getUserConfigRoot()
}

export function getStoragePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".ncoworker", "agent.sqlite")
}

export function getServerStoragePath(_workspaceRoot?: string): string {
  return join(getUserDataRoot(), "server.sqlite")
}

export function getDesktopStatePath(_repositoryRoot?: string): string {
  return join(getAppStateRoot(), "desktop-state.json")
}

export function getDesktopSettingsPath(_repositoryRoot?: string): string {
  return join(getAppStateRoot(), "desktop-settings.json")
}

export function getAgentsDir(_workspaceRoot?: string): string {
  return join(getUserConfigRoot(), "agents")
}

// Reset warning state (for testing)
export function _resetWarningState(): void {
  warnedPaths.clear()
}
