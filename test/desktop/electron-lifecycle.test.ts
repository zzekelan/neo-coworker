import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
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
