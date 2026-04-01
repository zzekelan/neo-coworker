import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop settings panel", () => {
  test("wraps the app in a language provider and persists settings through the desktop hook", () => {
    const appSource = readFileSync("src/desktop/src/App.tsx", "utf8")
    const hookSource = readFileSync("src/desktop/src/useDesktopSettings.ts", "utf8")

    expect(appSource).toContain("<DesktopTextProvider language={desktopSettings.settings.language}>")
    expect(hookSource).toContain("loadDesktopSettings()")
    expect(hookSource).toContain("saveDesktopSettings(nextSettings)")
    expect(hookSource).toContain("applyDesktopSettings(settings)")
  })

  test("shows editable language controls and blocks LLM apply when server mode or run state disallow it", () => {
    const panelSource = readFileSync("src/desktop/src/components/SettingsPanel.tsx", "utf8")

    expect(panelSource).toContain("<option value=\"en\">English</option>")
    expect(panelSource).toContain("<option value=\"zh\">中文</option>")
    expect(panelSource).toContain("const llmFieldsDisabled = serverMode !== \"managed-local\"")
    expect(panelSource).toContain("const applyDisabled = llmFieldsDisabled || isApplying || hasBusySession")
    expect(panelSource).toContain("text.settings.externalHint")
    expect(panelSource).toContain("text.settings.stopRunsFirst")
  })
})
