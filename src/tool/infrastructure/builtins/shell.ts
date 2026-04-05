import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  SHELL_ABORT_GRACE_MS,
  createToolAbortError,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd: string
      stdin: "ignore"
      stdout: "pipe"
      stderr: "pipe"
    },
  ): {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
    kill(signal?: string): void
  }
}

const ShellArgsSchema = z.object({
  command: z.string().trim().min(1, "Command must not be empty").describe(
    "Bash command to run with the workspace root as the current directory, such as `git status`, `bun test test/runtime/tools`, or `rg \"TODO\" src`. Prefer dedicated tools for simple file reads, writes, edits, globbing, and literal text search; use shell for OS commands, scripts, or capabilities those tools do not expose.",
  ),
  timeoutMs: z.optional(z.number().int().min(1, "Timeout must be at least 1ms")).describe(
    "Optional timeout in milliseconds. When provided, the process is terminated with SIGTERM and then SIGKILL after the normal grace period if it still has not exited.",
  ),
  workdir: z.optional(z.string().trim().min(1, "Workdir must not be empty")).describe(
    "Optional workspace-relative working directory for the command. When omitted, the command runs from the workspace root. The resolved directory must stay inside the workspace and cannot target `.agents/**`.",
  ),
}).describe(
  "Execute a bash command with the workspace root or an optional workspace-relative working directory as the current directory. Use this for OS tools, git, Bun scripts, or multi-step commands that are not covered by the dedicated workspace and web tools. This tool requires permission before execution. Prefer `read`, `write`, `edit`, `glob`, and `grep` for simple workspace file operations because they are safer and more structured. Optional `timeoutMs` can forcibly stop long-running commands.",
)

async function resolveWorkspaceDirectory(workspaceRoot: string, relativePath?: string) {
  const root = await realpath(resolve(workspaceRoot))

  if (relativePath === undefined) {
    return root
  }

  const directory = await realpath(resolve(root, relativePath))

  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  const workspacePath = relative(root, directory)
  if (workspacePath === ".agents" || workspacePath.startsWith(`.agents${sep}`)) {
    throw new Error(`Path is reserved for agent runtime data: ${relativePath}`)
  }

  return directory
}

async function terminateProcess(process: { kill(signal?: string): void; exited: Promise<number> }) {
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
}

export function createShellTool(input: { requestPermission: RequestToolPermission }): ToolDefinition {
  return {
    name: "shell",
    description: "Run a shell command with the workspace as the current directory",
    inputSchema: ShellArgsSchema,
    async execute(value) {
      const signal = value.signal

      throwIfToolAborted(signal)
      const { command, timeoutMs, workdir } = ShellArgsSchema.parse(value.args)
      const decision = await input.requestPermission({
        toolName: "shell",
        reason: `shell ${command}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(signal)
      const cwd = await resolveWorkspaceDirectory(value.workspaceRoot, workdir)
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
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const execution = signal
        ? Promise.race([
            completed,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                void (async () => {
                  try {
                    await terminateProcess(process)
                  } catch {}

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

      const timeoutExecution = timeoutMs
        ? Promise.race([
            execution,
            new Promise<never>((_resolve, reject) => {
              timeoutId = setTimeout(() => {
                void (async () => {
                  try {
                    await terminateProcess(process)
                  } catch {}

                  reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
                })()
              }, timeoutMs)
            }),
          ])
        : execution

      try {
        const [stdout, stderr, exitCode] = await timeoutExecution
        const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")

        if (exitCode !== 0) {
          throw new Error(output || `Shell command failed with exit code ${exitCode}`)
        }

        return { output }
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
        }

        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort)
        }
      }
    },
  }
}
