import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const SOURCE_CONTRACT_FILES = [
  "src/bootstrap/server-app.ts",
  "src/app-server/notifications.ts",
  "src/app-server/server.ts",
  "src/cli/cli-server-client.ts",
  "src/cli/cli-render.ts",
  "src/cli/chat-render.ts",
  "src/desktop/src/api.ts",
  "src/desktop/src/types.ts",
  "src/desktop/src/useDesktopApp.ts",
] as const

const CONTRACT_TEST_FILES = [
  "test/server/http-api-and-sse.test.ts",
  "test/cli/agent-flag.test.ts",
  "test/desktop/dev-server-config.test.ts",
] as const

describe("App Server Notification contract", () => {
  test("rejects legacy app-server push contract names", () => {
    const forbiddenEverywhere = [
      { label: "ServerEvent", pattern: /\bServerEvent\b/ },
      { label: "message.created", pattern: /\bmessage\.created\b/ },
      { label: "message.part.updated", pattern: /\bmessage\.part\.updated\b/ },
      { label: "event bus terminology", pattern: /\bevent[- ]bus\b|\bserver event contract\b/i },
    ]
    const forbiddenInSource = [
      { label: "runtime.error", pattern: /\bruntime\.error\b/ },
    ]

    const findings = [...SOURCE_CONTRACT_FILES, ...CONTRACT_TEST_FILES].flatMap(
      (file) => {
        const source = readFileSync(file, "utf8")
        return forbiddenEverywhere
          .filter(({ pattern }) => pattern.test(source))
          .map(({ label }) => `${file}: ${label}`)
      },
    )
    const sourceFindings = SOURCE_CONTRACT_FILES.flatMap((file) => {
      const source = readFileSync(file, "utf8")
      return forbiddenInSource
        .filter(({ pattern }) => pattern.test(source))
        .map(({ label }) => `${file}: ${label}`)
    })

    expect([...findings, ...sourceFindings]).toEqual([])
  })

  test("does not support the old public subscription route in source", () => {
    const findings = SOURCE_CONTRACT_FILES.flatMap((file) => {
      const source = readFileSync(file, "utf8")
      return source.includes("/events") ? [file] : []
    })

    expect(findings).toEqual([])
  })
})
