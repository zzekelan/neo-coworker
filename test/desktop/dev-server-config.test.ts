import { describe, expect, test } from "bun:test"
import {
  DEFAULT_DESKTOP_APP_SERVER_ORIGIN,
  DEFAULT_DESKTOP_UI_HOST,
  buildDesktopDevServerConfig,
} from "../../src/desktop/dev-server-config"

describe("desktop dev server config", () => {
  test("binds the browser renderer to loopback by default", () => {
    const server = buildDesktopDevServerConfig({})

    expect(server.host).toBe(DEFAULT_DESKTOP_UI_HOST)
    expect(server.proxy["^/notifications$"]).toMatchObject({
      target: DEFAULT_DESKTOP_APP_SERVER_ORIGIN,
      changeOrigin: false,
      ws: false,
    })
    expect(server.proxy["^/events$"]).toBeUndefined()
    expect(server.proxy["^/runs(?:/.*)?$"]).toMatchObject({
      target: DEFAULT_DESKTOP_APP_SERVER_ORIGIN,
      changeOrigin: false,
      ws: false,
    })
  })

  test("allows an explicit public host only when opted in", () => {
    const server = buildDesktopDevServerConfig({
      host: "0.0.0.0",
      appServerOrigin: "http://127.0.0.1:4100",
    })

    expect(server.host).toBe("0.0.0.0")
    expect(server.proxy["^/sessions(?:/.*)?$"]).toMatchObject({
      target: "http://127.0.0.1:4100",
      changeOrigin: false,
      ws: false,
    })
  })
})
