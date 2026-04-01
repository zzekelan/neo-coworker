import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const DEFAULT_SETTINGS = {
  language: "en",
  provider: "",
  apiKey: "",
  model: "",
  baseURL: "",
  timeoutMs: "",
}
const DESKTOP_SETTINGS_ENV_KEYS = new Set([
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "LLM_TIMEOUT_MS",
])

export function createDefaultDesktopSettings(env = process.env) {
  const provider = normalizeProvider(env.LLM_PROVIDER) ?? DEFAULT_SETTINGS.provider
  return {
    language: "en",
    provider,
    apiKey: normalizeString(env.LLM_API_KEY),
    model: normalizeString(env.LLM_MODEL),
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

export function readDesktopSettingsEnvFiles(root) {
  const env = {}

  for (const fileName of [".env", ".env.local"]) {
    try {
      const raw = readFileSync(resolve(root, fileName), "utf8")
      mergeDesktopSettingsEnv(env, raw)
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : null
      if (code !== "ENOENT") {
        throw error
      }
    }
  }

  return env
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

function mergeDesktopSettingsEnv(target, raw) {
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseDesktopSettingsEnvLine(line)
    if (!entry) {
      continue
    }

    target[entry.key] = entry.value
  }
}

function parseDesktopSettingsEnvLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) {
    return null
  }

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) {
    return null
  }

  const [, key, rawValue] = match
  if (!DESKTOP_SETTINGS_ENV_KEYS.has(key)) {
    return null
  }

  return {
    key,
    value: normalizeDesktopSettingsEnvValue(rawValue),
  }
}

function normalizeDesktopSettingsEnvValue(value) {
  const trimmed = value.trim()

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  const commentIndex = trimmed.search(/\s+#/)
  if (commentIndex === -1) {
    return trimmed
  }

  return trimmed.slice(0, commentIndex).trim()
}
