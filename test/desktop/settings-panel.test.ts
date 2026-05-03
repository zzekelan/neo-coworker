import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop settings panel", () => {
  test("wraps the app in a language provider and persists settings through the desktop hook", () => {
    const appSource = readFileSync("src/desktop/src/App.tsx", "utf8")
    const hookSource = readFileSync("src/desktop/src/useDesktopSettings.ts", "utf8")

    expect(appSource).toContain("<DesktopTextProvider language={desktopSettings.appliedSettings.language}>")
    expect(appSource).toContain("<ThemeProvider")
    expect(appSource).toContain("desktopSettings.settings.theme")
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
    expect(panelSource).toContain('<SectionHeading title={text.settings.llm} />\n                {serverMode !== "managed-local" ? (')
    expect(panelSource).toContain("disabled && \"cursor-not-allowed border-border/70 bg-surface/70 text-muted shadow-none\"")
    expect(panelSource).toContain('applyDisabled')
    expect(panelSource).toContain('"border border-border bg-surface text-muted shadow-none"')
  })

  test("renders a Reasoning subsection with capability-driven warning, thinking toggle, and effort options", () => {
    const panelSource = readFileSync("src/desktop/src/components/SettingsPanel.tsx", "utf8")
    const i18nSource = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    expect(panelSource).toContain("reasoningCapability?: DesktopReasoningCapability")
    expect(panelSource).toContain("function ReasoningSubsection")
    expect(panelSource).toContain("text.settings.reasoning")
    expect(panelSource).toContain("text.settings.reasoningUnknownModelWarning")
    expect(panelSource).toContain("text.settings.reasoningThinking")
    expect(panelSource).toContain("text.settings.reasoningEffort")
    expect(panelSource).toContain("text.settings.reasoningEffortDefault")
    expect(panelSource).toContain("text.settings.reasoningEffortLow")
    expect(panelSource).toContain("text.settings.reasoningEffortMedium")
    expect(panelSource).toContain("text.settings.reasoningEffortHigh")
    expect(panelSource).toContain("const showWarning = !capability || capability.catalogMiss")
    expect(panelSource).toContain(
      "const showThinking = !capability || capability.thinkingSupported || capability.catalogMiss",
    )
    expect(panelSource).toContain(
      "const showEffort = !capability || capability.reasoningEffortSupported || capability.catalogMiss",
    )
    expect(panelSource).toContain("thinkingEnabled: value === \"on\"")
    expect(panelSource).toContain("reasoningEffortMode: value")
    expect(panelSource).toContain("disabled={disabled}")

    expect(i18nSource).toContain("reasoning: \"Reasoning\"")
    expect(i18nSource).toContain("reasoning: \"推理\"")
    expect(i18nSource).toContain("reasoningUnknownModelWarning")
  })
})

describe("desktop compatibility i18n", () => {
  test("exposes EN/ZH copy for the legacy-session compatibility prompt", () => {
    const i18nSource = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    expect(i18nSource).toContain("legacySessionTitle: string")
    expect(i18nSource).toContain("legacySessionMessage: string")
    expect(i18nSource).toContain("continueWithoutThinking: string")
    expect(i18nSource).toContain("continueWithoutThinkingHint: string")
    expect(i18nSource).toContain("startNewSession: string")

    expect(i18nSource).toContain("legacySessionTitle: \"Session compatibility\"")
    expect(i18nSource).toContain("continueWithoutThinking: \"Continue without thinking\"")
    expect(i18nSource).toContain("startNewSession: \"Start new session\"")

    expect(i18nSource).toContain("legacySessionTitle: \"会话兼容性\"")
    expect(i18nSource).toContain("continueWithoutThinking: \"不带思考继续\"")
    expect(i18nSource).toContain("startNewSession: \"新建会话\"")
  })

  test("continue-without-thinking copy explicitly states the override is session-scoped until re-enabled or new session", () => {
    const i18nSource = readFileSync("src/desktop/src/i18n.tsx", "utf8")

    const enHint = i18nSource.match(/continueWithoutThinkingHint:\s*"([^"]+)"/)
    const zhHint = i18nSource.match(/continueWithoutThinkingHint:\s*"([^"]+)"/g)

    expect(enHint).not.toBeNull()
    expect(zhHint).not.toBeNull()
    expect(zhHint?.length ?? 0).toBeGreaterThanOrEqual(2)

    const enText = enHint?.[1] ?? ""
    expect(enText.toLowerCase()).toContain("this session")
    expect(enText.toLowerCase()).toContain("re-enable")
    expect(enText.toLowerCase()).toContain("new session")

    const zhText = (zhHint?.[1] ?? "").replace(/^continueWithoutThinkingHint:\s*"|"$/g, "")
    expect(zhText).toContain("本会话")
    expect(zhText).toContain("重新启用")
    expect(zhText).toContain("新建一个会话")
  })
})
