import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { homedir, tmpdir } from "os"
import { join } from "path"
import {
  getAgentsDir,
  getAppStateRoot,
  getConfigDir,
  getDesktopSettingsPath,
  getDesktopStatePath,
  getServerStoragePath,
  getStoragePath,
  getUserConfigRoot,
  getUserDataRoot,
  _resetWarningState,
} from "../../src/bootstrap/paths"

const APP_DIR_NAME = "neo-coworker"

function restoreEnv(name: "XDG_CONFIG_HOME" | "XDG_DATA_HOME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

describe("bootstrap paths", () => {
  async function withPathsTest(
    callback: (context: { tmpDir: string; workspaceRoot: string }) => void | Promise<void>,
  ): Promise<void> {
    const tmpDir = await mkdtemp(join(tmpdir(), "paths-test-"))
    const workspaceRoot = join(tmpDir, "workspace")
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    const originalXdgDataHome = process.env.XDG_DATA_HOME
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    _resetWarningState()

    try {
      await callback({ tmpDir, workspaceRoot })
    } finally {
      restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome)
      restoreEnv("XDG_DATA_HOME", originalXdgDataHome)
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  test("uses XDG_CONFIG_HOME for user config paths", async () => {
    await withPathsTest(({ tmpDir, workspaceRoot }) => {
      const xdgConfigHome = join(tmpDir, "xdg-config")
      process.env.XDG_CONFIG_HOME = xdgConfigHome

      expect(getUserConfigRoot()).toBe(join(xdgConfigHome, APP_DIR_NAME))
      expect(getConfigDir(workspaceRoot)).toBe(join(xdgConfigHome, APP_DIR_NAME))
      expect(getAgentsDir(workspaceRoot)).toBe(join(xdgConfigHome, APP_DIR_NAME, "agents"))
    })
  })

  test("uses XDG_DATA_HOME for user data and app-state paths", async () => {
    await withPathsTest(({ tmpDir, workspaceRoot }) => {
      const xdgDataHome = join(tmpDir, "xdg-data")
      process.env.XDG_DATA_HOME = xdgDataHome

      expect(getUserDataRoot()).toBe(join(xdgDataHome, APP_DIR_NAME))
      expect(getAppStateRoot()).toBe(join(xdgDataHome, APP_DIR_NAME))
      expect(getServerStoragePath(workspaceRoot)).toBe(join(xdgDataHome, APP_DIR_NAME, "server.sqlite"))
      expect(getDesktopStatePath(workspaceRoot)).toBe(
        join(xdgDataHome, APP_DIR_NAME, "desktop-state.json"),
      )
      expect(getDesktopSettingsPath(workspaceRoot)).toBe(
        join(xdgDataHome, APP_DIR_NAME, "desktop-settings.json"),
      )
    })
  })

  test("keeps workspace runtime storage under the workspace root", async () => {
    await withPathsTest(({ tmpDir, workspaceRoot }) => {
      process.env.XDG_DATA_HOME = join(tmpDir, "xdg-data")

      expect(getStoragePath(workspaceRoot)).toBe(
        join(workspaceRoot, ".ncoworker", "agent.sqlite"),
      )
    })
  })

  test("falls back to home XDG defaults when env vars are unset", async () => {
    await withPathsTest(({ workspaceRoot }) => {
      expect(getConfigDir(workspaceRoot)).toBe(join(homedir(), ".config", APP_DIR_NAME))
      expect(getServerStoragePath(workspaceRoot)).toBe(
        join(homedir(), ".local", "share", APP_DIR_NAME, "server.sqlite"),
      )
    })
  })

  test("ignores relative XDG env values", async () => {
    await withPathsTest(({ workspaceRoot }) => {
      process.env.XDG_CONFIG_HOME = "relative-config"
      process.env.XDG_DATA_HOME = "relative-data"

      expect(getConfigDir(workspaceRoot)).toBe(join(homedir(), ".config", APP_DIR_NAME))
      expect(getServerStoragePath(workspaceRoot)).toBe(
        join(homedir(), ".local", "share", APP_DIR_NAME, "server.sqlite"),
      )
    })
  })

  test("keeps runtime paths out of the workspace config directory", async () => {
    await withPathsTest(async ({ tmpDir, workspaceRoot }) => {
      process.env.XDG_CONFIG_HOME = join(tmpDir, "xdg-config")
      process.env.XDG_DATA_HOME = join(tmpDir, "xdg-data")
      await mkdir(join(workspaceRoot, ".ncoworker"), { recursive: true })

      const paths = [
        getConfigDir(workspaceRoot),
        getServerStoragePath(workspaceRoot),
        getDesktopStatePath(workspaceRoot),
        getDesktopSettingsPath(workspaceRoot),
        getAgentsDir(workspaceRoot),
      ]

      for (const p of paths) {
        expect(p).not.toContain(join(workspaceRoot, ".ncoworker"))
      }
    })
  })

  test("keeps app-state paths separate from the workspace root", async () => {
    await withPathsTest(({ tmpDir, workspaceRoot }) => {
      process.env.XDG_DATA_HOME = join(tmpDir, "xdg-data")

      const statePath = getDesktopStatePath(workspaceRoot)
      const settingsPath = getDesktopSettingsPath(workspaceRoot)

      expect(statePath).toBe(join(tmpDir, "xdg-data", APP_DIR_NAME, "desktop-state.json"))
      expect(settingsPath).toBe(join(tmpDir, "xdg-data", APP_DIR_NAME, "desktop-settings.json"))
      expect(statePath.startsWith(workspaceRoot)).toBe(false)
      expect(settingsPath.startsWith(workspaceRoot)).toBe(false)
    })
  })
})
