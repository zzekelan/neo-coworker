const API_PROXY_PATTERNS = [
  "^/health$",
  "^/events$",
  "^/sessions(?:/.*)?$",
  "^/workspaces(?:/.*)?$",
  "^/workspace(?:/.*)?$",
  "^/runs(?:/.*)?$",
  "^/permissions(?:/.*)?$",
]

export const DEFAULT_DESKTOP_APP_SERVER_ORIGIN = "http://127.0.0.1:3100"
export const DEFAULT_DESKTOP_UI_HOST = "127.0.0.1"

export function buildDesktopDevServerConfig(input: {
  appServerOrigin?: string
  host?: string
}) {
  const appServerOrigin = input.appServerOrigin?.trim() || DEFAULT_DESKTOP_APP_SERVER_ORIGIN
  const host = input.host?.trim() || DEFAULT_DESKTOP_UI_HOST

  return {
    host,
    proxy: Object.fromEntries(
      API_PROXY_PATTERNS.map((pattern) => [
        pattern,
        {
          target: appServerOrigin,
          changeOrigin: false,
          ws: false,
        },
      ]),
    ),
  }
}
