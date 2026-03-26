import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"

const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const

export type CliSelectItem = {
  label: string
  description?: string
}

export type CliIO = {
  write(text: string): void
  prompt(message: string, options?: { signal?: AbortSignal }): Promise<string>
  select?(message: string, items: CliSelectItem[]): Promise<number | null>
  startStatus?(text: string): void
  updateStatus?(text: string): void
  finishStatus?(text: string): void
  onSigint?(listener: () => void): void | (() => void)
  close?(): void
}

export function createStdioCliIo(): CliIO {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  let statusText: string | null = null
  let statusFrameIndex = 0
  let statusTimer: ReturnType<typeof setInterval> | null = null

  function stopStatusTimer() {
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
  }

  function renderStatusLine() {
    if (!interactive || !statusText) {
      return
    }

    process.stdout.write(`\r\x1b[2K${SPINNER_FRAMES[statusFrameIndex]} ${statusText}`)
  }

  function clearStatusLine() {
    if (!interactive || !statusText) {
      return
    }

    process.stdout.write("\r\x1b[2K")
  }

  function startStatusLine(text: string) {
    if (!interactive) {
      process.stdout.write(`| ${text}\n`)
      return
    }

    stopStatusTimer()
    statusText = text
    statusFrameIndex = 0
    renderStatusLine()
    statusTimer = setInterval(() => {
      statusFrameIndex = (statusFrameIndex + 1) % SPINNER_FRAMES.length
      renderStatusLine()
    }, 80)
  }

  function renderSelectScreen(message: string, items: CliSelectItem[], activeIndex: number) {
    process.stdout.write("\x1b[2J\x1b[H")
    process.stdout.write(`${message}\n`)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (!item) {
        continue
      }

      const prefix = index === activeIndex ? "> " : "  "
      process.stdout.write(`${prefix}${item.label}\n`)
      if (item.description) {
        process.stdout.write(`    ${item.description}\n`)
      }
    }

    process.stdout.write("\nUse ↑/↓ to choose, Enter to select, Esc to cancel.\n")
  }

  return {
    write(text) {
      const hadStatus = statusText != null
      if (hadStatus) {
        clearStatusLine()
      }

      process.stdout.write(text)

      if (hadStatus) {
        renderStatusLine()
      }
    },
    prompt(message, options) {
      return readline.question(message, {
        signal: options?.signal,
      })
    },
    async select(message, items) {
      if (items.length === 0) {
        return null
      }

      if (!interactive) {
        process.stdout.write(`${message}\n`)
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]
          if (!item) {
            continue
          }

          process.stdout.write(`${index + 1}. ${item.label}\n`)
          if (item.description) {
            process.stdout.write(`   ${item.description}\n`)
          }
        }

        const answer = await readline.question("Select a session (blank to cancel): ")
        const selection = Number.parseInt(answer, 10)

        if (!Number.isFinite(selection) || selection < 1 || selection > items.length) {
          return null
        }

        return selection - 1
      }

      stopStatusTimer()
      clearStatusLine()
      readline.pause()

      emitKeypressEvents(process.stdin)

      const stdin = process.stdin
      const previousRawMode = stdin.isTTY ? stdin.isRaw : undefined
      let activeIndex = 0

      if (stdin.isTTY) {
        stdin.setRawMode(true)
      }

      renderSelectScreen(message, items, activeIndex)

      try {
        return await new Promise<number | null>((resolve) => {
          let settled = false

          const finish = (value: number | null) => {
            if (settled) {
              return
            }

            settled = true
            stdin.off("keypress", onKeypress)
            stdin.off("end", onEnd)
            resolve(value)
          }

          const onKeypress = (_input: string, key: { ctrl?: boolean; name?: string }) => {
            if (key.ctrl && key.name === "c") {
              finish(null)
              return
            }

            if (key.name === "escape") {
              finish(null)
              return
            }

            if (key.name === "return") {
              finish(activeIndex)
              return
            }

            if (key.name === "up") {
              activeIndex = activeIndex === 0 ? items.length - 1 : activeIndex - 1
              renderSelectScreen(message, items, activeIndex)
              return
            }

            if (key.name === "down") {
              activeIndex = activeIndex === items.length - 1 ? 0 : activeIndex + 1
              renderSelectScreen(message, items, activeIndex)
            }
          }

          const onEnd = () => {
            finish(null)
          }

          stdin.on("keypress", onKeypress)
          stdin.once("end", onEnd)
        })
      } finally {
        if (stdin.isTTY) {
          stdin.setRawMode(Boolean(previousRawMode))
        }

        process.stdout.write("\x1b[2J\x1b[H")
        readline.resume()
      }
    },
    startStatus(text) {
      startStatusLine(text)
    },
    updateStatus(text) {
      if (!interactive) {
        return
      }

      if (!statusText) {
        startStatusLine(text)
        return
      }

      statusText = text
      renderStatusLine()
    },
    finishStatus(text) {
      stopStatusTimer()

      if (!interactive) {
        process.stdout.write(`✓ ${text}\n`)
        return
      }

      const hadStatus = statusText != null
      statusText = null

      if (hadStatus) {
        process.stdout.write(`\r\x1b[2K✓ ${text}\n`)
        return
      }

      process.stdout.write(`✓ ${text}\n`)
    },
    onSigint(listener) {
      process.on("SIGINT", listener)

      return () => {
        process.off("SIGINT", listener)
      }
    },
    close() {
      stopStatusTimer()
      if (statusText) {
        clearStatusLine()
        statusText = null
      }
      readline.close()
    },
  }
}
