import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const DEFAULT_SETTINGS = {
  language: "en",
  provider: "openai",
  apiKey: "",
  model: "gpt-5",
  baseURL: "",
  timeoutMs: "",
}

export function createDefaultDesktopSettings(env = process.env) {
  const provider = normalizeProvider(env.LLM_PROVIDER)
  return {
    language: "en",
    provider,
    apiKey: normalizeString(env.LLM_API_KEY),
    model: normalizeString(env.LLM_MODEL) || "gpt-5",
    baseURL: normalizeString(env.LLM_BASE_URL),
    timeoutMs: normalizeTimeout(env.LLM_TIMEOUT_MS),
  }
}

export function readDesktopSettingsState(filePath, defaults = createDefaultDesktopSettings()) {
  try {
    const raw = readFileSync(filePath, "utf8")
    return normalizeDesktopSettingsState(JSON.parse(raw), defaults)
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null
    if (code === "ENOENT") {
      return defaults
    }

    return defaults
  }
}

export function writeDesktopSettingsState(filePath, settings, defaults = createDefaultDesktopSettings()) {
  const normalized = normalizeDesktopSettingsState(settings, defaults)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(normalized, null, 2))
  return normalized
}

export function normalizeDesktopSettingsState(value, defaults = DEFAULT_SETTINGS) {
  if (!value || typeof value !== "object") {
    return {
      ...defaults,
    }
  }

  const provider = normalizeProvider(value.provider) ?? defaults.provider

  return {
    language: normalizeLanguage(value.language) ?? defaults.language,
    provider,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : defaults.apiKey,
    model:
      typeof value.model === "string" && value.model.trim().length > 0
        ? value.model.trim()
        : defaults.model,
    baseURL: typeof value.baseURL === "string" ? value.baseURL.trim() : defaults.baseURL,
    timeoutMs:
      typeof value.timeoutMs === "string"
        ? normalizeTimeout(value.timeoutMs)
        : defaults.timeoutMs,
  }
}

function normalizeLanguage(value) {
  return value === "zh" ? "zh" : value === "en" ? "en" : null
}

function normalizeProvider(value) {
  return value === "openai-compatible" ? "openai-compatible" : value === "openai" ? "openai" : null
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeTimeout(value) {
  if (typeof value !== "string") {
    return ""
  }

  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) ? trimmed : ""
}
