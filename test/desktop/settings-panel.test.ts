import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop settings panel", () => {
  test("wraps the app in a language provider and persists settings through the desktop hook", () => {
    const appSource = readFileSync("src/desktop/src/App.tsx", "utf8")
    const hookSource = readFileSync("src/desktop/src/useDesktopSettings.ts", "utf8")

    expect(appSource).toContain("<DesktopTextProvider language={desktopSettings.appliedSettings.language}>")
    expect(appSource).toContain("document.documentElement.dataset.theme = desktopSettings.settings.theme")
    expect(appSource).toContain("void desktopSettings.applyGeneralSettings()")
    expect(appSource).toContain("void desktopSettings.applyLlmSettings().then((restarted) => {")
    expect(appSource).toContain("void refreshAppState()")
    expect(hookSource).toContain("loadDesktopSettings()")
    expect(hookSource).toContain("saveDesktopSettings(settings)")
    expect(hookSource).toContain("applyDesktopSettings(settings)")
  })

  test("shows editable language controls and blocks LLM apply when server mode or run state disallow it", () => {
    const panelSource = readFileSync("src/desktop/src/components/SettingsPanel.tsx", "utf8")

    expect(panelSource).toContain('{ value: "en", label: "English" }')
    expect(panelSource).toContain('{ value: "zh", label: "中文" }')
    expect(panelSource).toContain("text.settings.theme")
    expect(panelSource).toContain('{ value: "dark", label: text.settings.themeDark }')
    expect(panelSource).toContain('{ value: "light", label: text.settings.themeLight }')
    expect(panelSource).toContain("const llmFieldsDisabled = serverMode !== \"managed-local\"")
    expect(panelSource).toContain("llmFieldsDisabled || isApplying || hasBusySession")
    expect(panelSource).toContain("text.settings.externalHint")
    expect(panelSource).toContain("text.settings.stopRunsFirst")
  })
})
