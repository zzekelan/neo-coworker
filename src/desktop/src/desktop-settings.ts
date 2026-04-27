export type DesktopLanguage = "en" | "zh"
export type DesktopTheme = "dark" | "light"
export type DesktopServerMode = "managed-local" | "external"
export type DesktopProviderKind = "" | "openai" | "openai-compatible"
export type DesktopReasoningEffortMode = "default" | "low" | "medium" | "high"

export type DesktopSettings = {
  language: DesktopLanguage
  theme: DesktopTheme
  provider: DesktopProviderKind
  apiKey: string
  model: string
  baseURL: string
  timeoutMs: string
  thinkingEnabled: boolean
  reasoningEffortMode: DesktopReasoningEffortMode
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  language: "en",
  theme: "light",
  provider: "",
  apiKey: "",
  model: "",
  baseURL: "",
  timeoutMs: "",
  thinkingEnabled: false,
  reasoningEffortMode: "default",
}
