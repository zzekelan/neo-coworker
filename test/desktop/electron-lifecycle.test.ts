import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { buildLoopbackEnv } from "../../src/desktop/electron/env.mjs"
import {
  createChildHandle,
  createQuitCoordinator,
  waitForManagedChildStartup,
} from "../../src/desktop/electron/lifecycle.mjs"

describe("desktop electron lifecycle", () => {
  test("prevents quit until asynchronous cleanup completes", async () => {
    let resolveCleanup: (() => void) | null = null
    let cleanupCalls = 0
    let quitCalls = 0

    const coordinator = createQuitCoordinator({
      cleanup() {
        cleanupCalls += 1
        return new Promise<void>((resolvePromise) => {
          resolveCleanup = resolvePromise
        })
      },
      quit() {
        quitCalls += 1
      },
    })

    const firstEvent = createQuitEvent()
    coordinator.handleBeforeQuit(firstEvent)

    expect(firstEvent.prevented).toBe(true)
    expect(cleanupCalls).toBe(1)
    expect(quitCalls).toBe(0)

    const secondEvent = createQuitEvent()
    coordinator.handleBeforeQuit(secondEvent)

    expect(secondEvent.prevented).toBe(true)
    expect(cleanupCalls).toBe(1)

    resolveCleanup?.()
    await Bun.sleep(0)

    expect(quitCalls).toBe(1)

    const afterCleanupEvent = createQuitEvent()
    coordinator.handleBeforeQuit(afterCleanupEvent)

    expect(afterCleanupEvent.prevented).toBe(false)
    expect(cleanupCalls).toBe(1)
    expect(quitCalls).toBe(1)
  })

  test("forces child shutdown if SIGTERM does not exit in time", async () => {
    const child = new FakeChildProcess({ graceful: false })
    const handle = createChildHandle(child, { exitTimeoutMs: 10 })

    const closing = handle.close()
    await Bun.sleep(20)
    child.exit(0)
    await closing

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("stops at SIGTERM when the child exits promptly", async () => {
    const child = new FakeChildProcess({ graceful: true })
    const handle = createChildHandle(child, { exitTimeoutMs: 10 })

    await handle.close()

    expect(child.signals).toEqual(["SIGTERM"])
  })

  test("registers the child handle before waiting for startup readiness", async () => {
    const child = new FakeChildProcess({ graceful: true })
    const order: string[] = []

    const started = await waitForManagedChildStartup({
      child,
      assignHandle() {
        order.push("assign")
      },
      async waitUntilReady() {
        order.push("ready")
        return "ready"
      },
    })

    expect(started).toBe("ready")
    expect(order).toEqual(["assign", "ready"])
  })

  test("preserves outbound proxy variables while bypassing loopback", () => {
    const env = buildLoopbackEnv(
      {
        NCOWORKER_SERVER_HOST: "127.0.0.1",
        NCOWORKER_SERVER_PORT: "3100",
      },
      {
        HTTP_PROXY: "http://127.0.0.1:7897",
        HTTPS_PROXY: "http://127.0.0.1:7897",
        ALL_PROXY: "socks5://127.0.0.1:7897",
        NO_PROXY: "example.internal",
        no_proxy: "metadata.internal",
      },
    )

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897")
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897")
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:7897")
    expect(env.NO_PROXY).toBe("example.internal,127.0.0.1,localhost")
    expect(env.no_proxy).toBe("metadata.internal,127.0.0.1,localhost")
    expect(env.NCOWORKER_SERVER_HOST).toBe("127.0.0.1")
    expect(env.NCOWORKER_SERVER_PORT).toBe("3100")
  })

  test("closes the child when startup readiness fails", async () => {
    const child = new FakeChildProcess({ graceful: true })
    let assignedHandleCount = 0

    await expect(
      waitForManagedChildStartup({
        child,
        assignHandle() {
          assignedHandleCount += 1
        },
        async waitUntilReady() {
          throw new Error("startup failed")
        },
      }),
    ).rejects.toThrow("startup failed")

    expect(assignedHandleCount).toBe(1)
    expect(child.signals).toEqual(["SIGTERM"])
    expect(child.exitCode).toBe(0)
  })

  test("wires settings bridge handlers and managed app-server restart through the Electron shell", () => {
    const mainSource = readFileSync("src/desktop/electron/main.mjs", "utf8")
    const preloadSource = readFileSync("src/desktop/electron/preload.cjs", "utf8")

    expect(mainSource).toContain("readDesktopSettingsEnvFiles(repositoryRoot)")
    expect(mainSource).toContain("currentServerOrigin = null")
    expect(mainSource).toContain("createUnavailableServerResponse()")
    expect(mainSource).not.toContain("process.loadEnvFile")
    expect(mainSource).toContain("neo-coworker:load-settings")
    expect(mainSource).toContain("neo-coworker:save-settings")
    expect(mainSource).toContain("neo-coworker:apply-settings")
    expect(mainSource).toContain("await ensureNoActiveRuns(currentServerOrigin)")
    expect(mainSource).toContain("await setManagedLocalServerUnavailable(error)")
    expect(mainSource).toContain("function recordUnavailableServer(error)")
    expect(mainSource).toContain("if (response.status === 503)")
    expect(mainSource).toContain("handleBridgeError(detail)")
    expect(mainSource).toContain("if (await setManagedLocalServerUnavailable(error))")
    expect(mainSource).toContain("throw error")
    expect(mainSource).toContain("function isBusySessionRunStatus(status)")
    expect(mainSource).toContain("status === \"queued\" || status === \"running\" || status === \"waiting_permission\"")
    expect(mainSource).toContain("currentServerMode !== \"managed-local\"")
    expect(mainSource).toContain("await restartManagedLocalServer({")
    expect(mainSource).toContain("delete env.LLM_THINKING_ENABLED")
    expect(mainSource).toContain("delete env.LLM_REASONING_EFFORT")
    expect(mainSource).toContain('env.LLM_THINKING_ENABLED = input.settings.thinkingEnabled ? "true" : "false"')
    expect(mainSource).toContain("env.LLM_REASONING_EFFORT = input.settings.reasoningEffortMode")
    expect(preloadSource).toContain("serverMode: readArgument(\"--neo-coworker-server-mode=\")")
    expect(preloadSource).toContain("loadDesktopSettings()")
    expect(preloadSource).toContain("saveDesktopSettings(input)")
    expect(preloadSource).toContain("applyDesktopSettings(input)")
  })
})

function createQuitEvent() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null
  readonly signals: string[] = []
  readonly graceful: boolean

  constructor(input: { graceful: boolean }) {
    super()
    this.graceful = input.graceful
  }

  kill(signal: string) {
    this.signals.push(signal)

    if (signal === "SIGTERM" && this.graceful) {
      queueMicrotask(() => {
        this.exit(0)
      })
    }
  }

  exit(code: number) {
    if (this.exitCode != null) {
      return
    }

    this.exitCode = code
    this.emit("exit", code)
  }
}
