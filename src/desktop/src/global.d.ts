export {}

declare global {
  interface Window {
    neoCoworkerDesktop?: {
      apiOrigin?: string
      platform?: string
      defaultWorkspaceRoot?: string
      persistedWorkspaceRoot?: string
      persistedSessionId?: string
      pickDirectory?: () => Promise<string | null>
      persistSelection?: (input: {
        activeWorkspaceRoot: string | null
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
