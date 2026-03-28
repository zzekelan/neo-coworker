export {}

declare global {
  interface Window {
    neoCoworkerDesktop?: {
      apiOrigin?: string
      platform?: string
      defaultWorkspaceRoot?: string
      persistedProjectRoot?: string
      persistedSessionId?: string
      pickDirectory?: () => Promise<string | null>
      persistSelection?: (input: {
        activeProjectRoot: string | null
        activeSessionId: string | null
      }) => Promise<boolean>
      requestJson?: (input: {
        path: string
        method?: string
        body?: unknown
      }) => Promise<{ ok: boolean; status: number; body: unknown }>
    }
  }
}
