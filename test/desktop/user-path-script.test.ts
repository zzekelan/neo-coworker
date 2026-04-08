import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop user-path verify script", () => {
  test("exposes a reusable desktop:verify script and keeps the key user-path assertions", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>
    }
    const scriptSource = readFileSync("scripts/desktop-user-path-check.mjs", "utf8")
    const mainSource = readFileSync("src/desktop/electron/main.mjs", "utf8")

    expect(packageJson.scripts?.["desktop:verify"]).toBe("node ./scripts/desktop-user-path-check.mjs")
    expect(scriptSource).toContain("mkdtempSync(join(tmpdir(), \"neo-coworker-desktop-verify-\"))")
    expect(scriptSource).toContain("DESKTOP_SELECTION_STATE_PATH")
    expect(scriptSource).toContain("DESKTOP_SETTINGS_STATE_PATH")
    expect(scriptSource).toContain("NCOWORKER_SERVER_DB_PATH")
    expect(scriptSource).toContain("join(isolatedDesktopStateRoot, \"server.sqlite\")")
    expect(scriptSource).toContain("window.neoCoworkerDesktop.persistedWorkspaceRoot")
    expect(scriptSource).toContain("page.getByRole(\"button\", { name: /Settings|设置/ })")
    expect(scriptSource).toContain("bridge.loadDesktopSettings()")
    expect(scriptSource).toContain("page.getByRole(\"button\", { name: /LLM Settings|LLM 设置/ })")
    expect(scriptSource).toContain("page.getByRole(\"button\", { name: /Apply LLM Settings|应用 LLM 设置/ })")
    expect(scriptSource).toContain("Desktop settings apply did not leave the managed app-server reachable.")
    expect(scriptSource).toContain("page.getByTitle(\"New Session\")")
    expect(scriptSource).toContain("page.locator(\"button[type=submit]\")")
    expect(scriptSource).toContain("matchesExpectedAssistantText")
    expect(scriptSource).toContain("normalizeAssistantText")
    expect(scriptSource).toContain("part.kind === \"text\"")
    expect(scriptSource).toContain("Assistant transcript text is empty.")
    expect(mainSource).toContain("process.env.DESKTOP_SELECTION_STATE_PATH?.trim() ||")
    expect(mainSource).toContain("process.env.DESKTOP_SETTINGS_STATE_PATH?.trim() ||")
  })
})
