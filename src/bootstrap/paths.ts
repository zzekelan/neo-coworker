import { existsSync } from "fs"
import { join, dirname, extname } from "path"

// Tracks warnings emitted to avoid duplicate console.warn
const warnedPaths = new Set<string>()

function pathOrParentExists(p: string): boolean {
  return existsSync(p) || (extname(p) !== "" && existsSync(dirname(p)))
}

function legacyFallback(newPath: string, legacyPath: string): string {
  if (!pathOrParentExists(newPath) && pathOrParentExists(legacyPath)) {
    if (!warnedPaths.has(legacyPath)) {
      console.warn(
        `[ncoworker] Legacy path detected: ${legacyPath}. ` +
          `Consider migrating to ${newPath}.`,
      )
      warnedPaths.add(legacyPath)
    }
    return legacyPath
  }
  return newPath
}

export function getConfigDir(workspaceRoot: string): string {
  return legacyFallback(join(workspaceRoot, ".ncoworker"), join(workspaceRoot, ".agents"))
}

export function getStoragePath(workspaceRoot: string): string {
  return legacyFallback(
    join(workspaceRoot, ".ncoworker", "agent.sqlite"),
    join(workspaceRoot, ".agents", "agent.sqlite"),
  )
}

export function getServerStoragePath(workspaceRoot: string): string {
  return legacyFallback(
    join(workspaceRoot, ".ncoworker", "server.sqlite"),
    join(workspaceRoot, ".agents", "server.sqlite"),
  )
}

export function getDesktopStatePath(repositoryRoot: string): string {
  return legacyFallback(
    join(repositoryRoot, ".ncoworker", "desktop-state.json"),
    join(repositoryRoot, ".agents", "desktop-state.json"),
  )
}

export function getDesktopSettingsPath(repositoryRoot: string): string {
  return legacyFallback(
    join(repositoryRoot, ".ncoworker", "desktop-settings.json"),
    join(repositoryRoot, ".agents", "desktop-settings.json"),
  )
}

export function getAgentsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".ncoworker", "agents")
}

// Reset warning state (for testing)
export function _resetWarningState(): void {
  warnedPaths.clear()
}
