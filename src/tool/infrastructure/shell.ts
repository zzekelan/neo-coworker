import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import {
  SHELL_ABORT_GRACE_MS,
  createToolAbortError,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../domain"
import { createToolPermissionDeniedError } from "./errors"

const ShellArgsSchema = z.object({
  command: z.string().trim().min(1, "Command must not be empty"),
})

export function createShellTool(input: { requestPermission: RequestToolPermission }): ToolDefinition {
  return {
    name: "shell",
    description: "Run a shell command with the workspace as the current directory",
    inputSchema: ShellArgsSchema,
    async execute(value) {
      const signal = value.signal

      throwIfToolAborted(signal)
      const { command } = ShellArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "shell",
        reason: `shell ${command}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(signal)
      const cwd = await realpath(resolve(value.workspaceRoot))
      throwIfToolAborted(signal)
      const process = Bun.spawn(["bash", "-lc", command], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })

      const completed = Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]) as Promise<[string, string, number]>
      void completed.catch(() => {
        // Avoid unhandled rejections when shutdown races tool completion.
      })

      let onAbort: (() => void) | null = null
      const execution = signal
        ? Promise.race([
            completed,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                void (async () => {
                  try {
                    process.kill("SIGTERM")
                  } catch {
                    // Process may have already exited.
                  }

                  const forceKillTimer = setTimeout(() => {
                    try {
                      process.kill("SIGKILL")
                    } catch {
                      // Process may have already exited.
                    }
                  }, SHELL_ABORT_GRACE_MS)

                  try {
                    await process.exited
                  } finally {
                    clearTimeout(forceKillTimer)
                  }

                  reject(createToolAbortError())
                })()
              }

              if (signal.aborted) {
                onAbort()
                return
              }

              signal.addEventListener("abort", onAbort, { once: true })
            }),
          ])
        : completed

      try {
        const [stdout, stderr, exitCode] = await execution
        const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")

        if (exitCode !== 0) {
          throw new Error(output || `Shell command failed with exit code ${exitCode}`)
        }

        return { output }
      } finally {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort)
        }
      }
    },
  }
}
