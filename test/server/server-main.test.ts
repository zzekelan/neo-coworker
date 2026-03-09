import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveAgentServerOrigin } from "../../src/main"
import {
  getDefaultStandaloneServerStoragePath,
  resolveStandaloneServerConfig,
} from "../../src/server-main"

describe("standalone server config", () => {
  test("derives the default storage path from the launch cwd", () => {
    expect(getDefaultStandaloneServerStoragePath("/tmp/neo-workspace")).toBe(
      join("/tmp/neo-workspace", ".agents", "server.sqlite"),
    )
  })

  test("reads host, port, and database path from AGENT_SERVER_* variables", () => {
    expect(
      resolveStandaloneServerConfig(
        {
          AGENT_SERVER_HOST: "0.0.0.0",
          AGENT_SERVER_PORT: "4317",
          AGENT_SERVER_DB_PATH: "/tmp/custom-server.sqlite",
        },
        "/tmp/ignored",
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 4317,
      databasePath: "/tmp/custom-server.sqlite",
    })
  })

  test("rejects invalid AGENT_SERVER_PORT values", () => {
    expect(() =>
      resolveStandaloneServerConfig(
        {
          AGENT_SERVER_PORT: "port",
        },
        "/tmp/neo-workspace",
      ),
    ).toThrow("AGENT_SERVER_PORT must be a valid integer")
  })
})

describe("agent server origin", () => {
  test("accepts AGENT_SERVER_URL when it is an absolute HTTP URL", () => {
    expect(
      resolveAgentServerOrigin({
        AGENT_SERVER_URL: "http://127.0.0.1:3100",
      }),
    ).toBe("http://127.0.0.1:3100")
  })

  test("rejects AGENT_SERVER_URL when the value is not absolute", () => {
    expect(() =>
      resolveAgentServerOrigin({
        AGENT_SERVER_URL: "/relative",
      }),
    ).toThrow("AGENT_SERVER_URL must be a valid absolute URL")
  })
})
