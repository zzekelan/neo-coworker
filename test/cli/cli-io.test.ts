import { afterEach, describe, expect, test } from "bun:test"

import { createStdioCliIo } from "../../src/cli"

const restorers: Array<() => void> = []

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()?.()
  }
})

describe("createStdioCliIo", () => {
  test("resumes stdin before waiting for interactive selector keypresses", async () => {
    const stdin = process.stdin
    const stdout = process.stdout
    let interactiveSelectActive = false

    overrideValue(stdin, "isTTY", true)
    overrideValue(stdout, "isTTY", true)
    overrideValue(stdin, "isRaw", false)
    overrideMethod(stdin, "pause", () => stdin)
    overrideMethod(stdout, "write", () => true)
    overrideMethod(stdin, "setRawMode", (value: boolean) => {
      overrideValue(stdin, "isRaw", value)
      return stdin
    })
    overrideMethod(stdin, "resume", () => {
      if (interactiveSelectActive) {
        setTimeout(() => {
          stdin.emit("keypress", "", { name: "return" })
        }, 0)
      }

      return stdin
    })

    const io = createStdioCliIo()
    interactiveSelectActive = true

    try {
      const selection = io.select?.("Resume a session", [
        {
          label: "hello",
          description: "hello | 2026-03-26 11:08",
        },
      ])

      expect(selection).toBeDefined()
      await expect(
        Promise.race([selection!, Bun.sleep(200).then(() => "timed_out" as const)]),
      ).resolves.toBe(0)
    } finally {
      interactiveSelectActive = false
      io.close?.()
    }
  })
})

function overrideValue<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)

  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value,
  })

  restorers.push(() => {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor)
      return
    }

    delete (target as Record<string, unknown>)[String(key)]
  })
}

function overrideMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: Extract<T[K], (...args: never[]) => unknown>,
) {
  const original = target[key]

  ;(target as Record<string, unknown>)[String(key)] = value
  restorers.push(() => {
    ;(target as Record<string, unknown>)[String(key)] = original
  })
}
