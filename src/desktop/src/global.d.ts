export {}

declare global {
  interface Window {
    neoCoworkerDesktop?: {
      apiOrigin?: string
      platform?: string
      serverMode?: "managed-local" | "external"
      defaultWorkspaceRoot?: string
      persistedWorkspaceRoot?: string
      persistedSessionId?: string
      pickDirectory?: () => Promise<string | null>
      persistSelection?: (input: {
        activeWorkspaceRoot: string | null
        activeSessionId: string | null
      }) => Promise<boolean>
      loadDesktopSettings?: () => Promise<{
        settings: import("./desktop-settings").DesktopSettings
        serverMode: import("./desktop-settings").DesktopServerMode
      }>
      saveDesktopSettings?: (input: import("./desktop-settings").DesktopSettings) => Promise<{
        settings: import("./desktop-settings").DesktopSettings
        serverMode: import("./desktop-settings").DesktopServerMode
      }>
      applyDesktopSettings?: (input: import("./desktop-settings").DesktopSettings) => Promise<{
        settings: import("./desktop-settings").DesktopSettings
        serverMode: import("./desktop-settings").DesktopServerMode
        restarted: boolean
      }>
      requestJson?: (input: {
        path: string
        method?: string
        body?: unknown
      }) => Promise<{ ok: boolean; status: number; body: unknown }>
    }
  }
}
