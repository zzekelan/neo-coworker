import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  readDesktopSelectionState,
  writeDesktopSelectionState,
} from "../../src/desktop/electron/selection-state.mjs"

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("desktop selection state", () => {
  test("persists the active workspace and session across restarts", () => {
    const filePath = createSelectionFilePath()

    writeDesktopSelectionState(filePath, {
      activeWorkspaceRoot: "/workspace/beta",
      activeSessionId: "session-42",
    })

    expect(readDesktopSelectionState(filePath)).toEqual({
      activeWorkspaceRoot: "/workspace/beta",
      activeSessionId: "session-42",
    })
  })

  test("falls back to null values when the file is malformed", () => {
    const filePath = createSelectionFilePath()
    writeFileSync(filePath, "{\"activeWorkspaceRoot\":42}")

    expect(readDesktopSelectionState(filePath)).toEqual({
      activeWorkspaceRoot: null,
      activeSessionId: null,
    })
  })
})

function createSelectionFilePath() {
  const directory = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-"))
  temporaryDirectories.push(directory)
  return join(directory, "desktop-state.json")
}
