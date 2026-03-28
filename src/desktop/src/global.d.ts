export {}

declare global {
  interface Window {
    neoCoworkerDesktop?: {
      apiOrigin?: string
      platform?: string
      defaultWorkspaceRoot?: string
      requestJson?: (input: {
        path: string
        method?: string
        body?: unknown
      }) => Promise<{ ok: boolean; status: number; body: unknown }>
    }
  }
}
