export type DesktopLanguage = "en" | "zh"
export type DesktopServerMode = "managed-local" | "external"
export type DesktopProviderKind = "openai" | "openai-compatible"

export type DesktopSettings = {
  language: DesktopLanguage
  provider: DesktopProviderKind
  apiKey: string
  model: string
  baseURL: string
  timeoutMs: string
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  language: "en",
  provider: "openai",
  apiKey: "",
  model: "gpt-5",
  baseURL: "",
  timeoutMs: "",
}
