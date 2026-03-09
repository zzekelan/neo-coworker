import { createInterface } from "node:readline/promises"

export type CliIO = {
  write(text: string): void
  prompt(message: string): Promise<string>
  onSigint?(listener: () => void): void | (() => void)
  close?(): void
}

export function createStdioCliIo(): CliIO {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return {
    write(text) {
      process.stdout.write(text)
    },
    prompt(message) {
      return readline.question(message)
    },
    onSigint(listener) {
      process.on("SIGINT", listener)

      return () => {
        process.off("SIGINT", listener)
      }
    },
    close() {
      readline.close()
    },
  }
}
