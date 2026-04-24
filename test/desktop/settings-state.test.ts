import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createDefaultDesktopSettings,
  readDesktopSettingsEnvFiles,
  readDesktopSettingsState,
  writeDesktopSettingsState,
// @ts-expect-error Electron helper is authored as .mjs without a declaration file.
} from "../../src/desktop/electron/settings-state.mjs"

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("desktop settings state", () => {
  test("persists language and LLM settings independently from selection state", () => {
    const filePath = createSettingsFilePath()

    const written = writeDesktopSettingsState(filePath, {
      language: "zh",
      theme: "light",
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "kimi-k2.5",
      baseURL: "https://example.invalid/v1",
      timeoutMs: "30000",
      thinkingEnabled: true,
      reasoningEffortMode: "high",
    })

    expect(written).toEqual({
      language: "zh",
      theme: "light",
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "kimi-k2.5",
      baseURL: "https://example.invalid/v1",
      timeoutMs: "30000",
      thinkingEnabled: true,
      reasoningEffortMode: "high",
    })
    expect(readDesktopSettingsState(filePath)).toEqual(written)
  })

  test("falls back to env-derived defaults when the settings file is malformed", () => {
    const filePath = createSettingsFilePath()
    writeFileSync(filePath, "{\"language\":42}")

    const defaults = createDefaultDesktopSettings({
      LLM_PROVIDER: "openai-compatible",
      LLM_API_KEY: "env-key",
      LLM_MODEL: "env-model",
      LLM_BASE_URL: "https://env.invalid/v1",
      LLM_TIMEOUT_MS: "45000",
      DESKTOP_THEME: "light",
    })

    expect(readDesktopSettingsState(filePath, defaults)).toEqual({
      language: "en",
      theme: "light",
      provider: "openai-compatible",
      apiKey: "env-key",
      model: "env-model",
      baseURL: "https://env.invalid/v1",
      timeoutMs: "45000",
      thinkingEnabled: false,
      reasoningEffortMode: "default",
    })
  })

  test("uses blank LLM settings when neither env nor persisted settings are present", () => {
    expect(createDefaultDesktopSettings({})).toEqual({
      language: "en",
      theme: "dark",
      provider: "",
      apiKey: "",
      model: "",
      baseURL: "",
      timeoutMs: "",
      thinkingEnabled: false,
      reasoningEffortMode: "default",
    })
  })

  test("reads only LLM settings from repo env files", () => {
    const directory = createSettingsDirectory()
    writeFileSync(
      join(directory, ".env"),
      [
        "LLM_PROVIDER=\"openai-compatible\"",
        "LLM_API_KEY=env-key",
        "NCOWORKER_SERVER_DB_PATH=\"$PWD/.ncoworker/server.sqlite\"",
      ].join("\n"),
    )
    writeFileSync(
      join(directory, ".env.local"),
      [
        "LLM_MODEL=local-model",
        "LLM_TIMEOUT_MS=45000",
      ].join("\n"),
    )

    expect(readDesktopSettingsEnvFiles(directory)).toEqual({
      LLM_PROVIDER: "openai-compatible",
      LLM_API_KEY: "env-key",
      LLM_MODEL: "local-model",
      LLM_TIMEOUT_MS: "45000",
    })
  })

  test("ignores reasoning controls coming from env files (UI-only preferences)", () => {
    const directory = createSettingsDirectory()
    writeFileSync(
      join(directory, ".env"),
      [
        "LLM_PROVIDER=openai",
        "LLM_THINKING_ENABLED=true",
        "LLM_REASONING_EFFORT=high",
      ].join("\n"),
    )

    expect(readDesktopSettingsEnvFiles(directory)).toEqual({
      LLM_PROVIDER: "openai",
    })
  })

  test("normalizes invalid reasoning controls back to defaults", () => {
    const filePath = createSettingsFilePath()

    const written = writeDesktopSettingsState(filePath, {
      language: "en",
      theme: "dark",
      provider: "openai-compatible",
      apiKey: "k",
      model: "m",
      baseURL: "",
      timeoutMs: "",
      thinkingEnabled: "yes",
      reasoningEffortMode: "ultra",
    })

    expect(written.thinkingEnabled).toBe(false)
    expect(written.reasoningEffortMode).toBe("default")
    expect(readDesktopSettingsState(filePath)).toEqual(written)
  })

  test("preserves false thinkingEnabled across save/load roundtrip", () => {
    const filePath = createSettingsFilePath()

    const written = writeDesktopSettingsState(filePath, {
      language: "en",
      theme: "dark",
      provider: "openai-compatible",
      apiKey: "k",
      model: "m",
      baseURL: "",
      timeoutMs: "",
      thinkingEnabled: false,
      reasoningEffortMode: "low",
    })

    expect(written.thinkingEnabled).toBe(false)
    expect(written.reasoningEffortMode).toBe("low")
    expect(readDesktopSettingsState(filePath).thinkingEnabled).toBe(false)
    expect(readDesktopSettingsState(filePath).reasoningEffortMode).toBe("low")
  })

  test("external-server desktop bridge keeps LLM reasoning fields view-only (no managed restart)", () => {
    const mainSource = readFileSync("src/desktop/electron/main.mjs", "utf8")

    expect(mainSource).toContain("if (currentServerMode !== \"managed-local\") {")
    expect(mainSource).toContain("restarted: false")
    const panelSource = readFileSync("src/desktop/src/components/SettingsPanel.tsx", "utf8")
    expect(panelSource).toContain("const llmFieldsDisabled = serverMode !== \"managed-local\"")
  })
})

function createSettingsFilePath() {
  return join(createSettingsDirectory(), "desktop-settings.json")
}

function createSettingsDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-settings-"))
  temporaryDirectories.push(directory)
  return directory
}
