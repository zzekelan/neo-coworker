import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createDefaultDesktopSettings,
  readDesktopSettingsEnvFiles,
  readDesktopSettingsState,
  writeDesktopSettingsState,
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
    })

    expect(written).toEqual({
      language: "zh",
      theme: "light",
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "kimi-k2.5",
      baseURL: "https://example.invalid/v1",
      timeoutMs: "30000",
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
    })
  })

  test("reads only LLM settings from repo env files", () => {
    const directory = createSettingsDirectory()
    writeFileSync(
      join(directory, ".env"),
      [
        "LLM_PROVIDER=\"openai-compatible\"",
        "LLM_API_KEY=env-key",
        "AGENT_SERVER_DB_PATH=\"$PWD/.agents/server.sqlite\"",
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
})

function createSettingsFilePath() {
  return join(createSettingsDirectory(), "desktop-settings.json")
}

function createSettingsDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-settings-"))
  temporaryDirectories.push(directory)
  return directory
}
