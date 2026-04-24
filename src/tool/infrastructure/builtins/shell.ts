import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  SHELL_ABORT_GRACE_MS,
  assertWorkspacePathNotReserved,
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

const OUTPUT_SIZE_CAP = 524288

const ShellArgsSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1, "Command must not be empty")
      .describe(
        "Bash command to execute in the workspace. Supports pipes, redirects, multi-step chains, and any OS-level capability. Prefer dedicated tools (read, write, edit, glob, grep) for simple file operations since they are safer and more structured. Commands that modify files, install packages, or run builds require permission before execution.",
      ),
    timeout: z
      .optional(z.number().int().min(1, "Timeout must be at least 1ms"))
      .describe(
        "Maximum time in milliseconds the command may run before it is force-killed. Defaults to 120000ms (2 minutes). Use a shorter value for commands known to complete quickly. When the timeout expires the process receives SIGTERM followed by SIGKILL after a brief grace period.",
      ),
    workdir: z
      .optional(z.string().trim().min(1, "Workdir must not be empty"))
      .describe(
        "Workspace-relative working directory for the command. When omitted the command runs from the workspace root. The resolved path must remain inside the workspace and cannot target .agents/** or unapproved .ncoworker/** runtime state. Explicit workspace subtrees such as .ncoworker/research/** are allowed.",
      ),
    description: z
      .optional(z.string().trim().min(1))
      .describe(
        "Short human-readable label for the command, e.g. 'Install dependencies' or 'Run tests'. When provided this label appears in progress updates so the user can track what the agent is doing.",
      ),
  })
  .describe(
    "Execute a bash command with the workspace root or an optional workspace-relative working directory as the current directory. Use this for OS tools, git, Bun scripts, or multi-step commands not covered by the dedicated workspace and web tools. Requires permission before execution for mutating operations. Supports configurable timeout, output size capping, and optional progress labelling via the description parameter.",
  )

async function resolveWorkspaceDirectory(workspaceRoot: string, relativePath?: string) {
  const root = await realpath(resolve(workspaceRoot))

  if (relativePath === undefined) {
    return root
  }

  assertWorkspacePathNotReserved(relativePath)

  const directory = await realpath(resolve(root, relativePath))

  if (directory !== root && !directory.startsWith(`${root}${sep}`)) {
    throw new Error(`Path must stay inside workspace: ${relativePath}`)
  }

  assertWorkspacePathNotReserved(relative(root, directory))

  return directory
}

async function terminateProcess(process: { kill(signal?: string): void; exited: Promise<number> }) {
  try {
    process.kill("SIGTERM")
  } catch {
    void 0
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill("SIGKILL")
    } catch {
      void 0
    }
  }, SHELL_ABORT_GRACE_MS)

  try {
    await process.exited
  } finally {
    clearTimeout(forceKillTimer)
  }
}

function applyOutputCap(output: string): { capped: string; truncated: boolean; originalSize: number } {
  const originalSize = Buffer.byteLength(output, "utf8")
  if (originalSize <= OUTPUT_SIZE_CAP) {
    return { capped: output, truncated: false, originalSize }
  }

  const truncated = Buffer.from(output, "utf8").slice(0, OUTPUT_SIZE_CAP).toString("utf8")
  const truncatedSize = Buffer.byteLength(truncated, "utf8")
  return {
    capped: `${truncated}\nOutput truncated (${originalSize}B → ${truncatedSize}B). Consider piping to a file for full output.`,
    truncated: true,
    originalSize,
  }
}

export function createShellTool(input: { requestPermission: RequestToolPermission }): ToolDefinition {
  return {
    name: "shell",
    description:
      "Execute a bash command in the workspace. Supports any OS-level capability including pipes, environment variables, package managers, build tools, and git. Commands run with the workspace root as the working directory by default. A configurable timeout (default 2 minutes) prevents runaway processes. Output is capped at 512KB to avoid context overflow. Non-zero exit codes and timeouts are returned as error results with structured metadata so the agent can respond without crashing the run.",
    inputSchema: ShellArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    timeout: 120_000,
    async execute(value) {
      const signal = value.signal

      throwIfToolAborted(signal)
      const { command, timeout, workdir, description } = ShellArgsSchema.parse(value.args)
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

      const startTime = Date.now()
      const proc = Bun.spawn(["bash", "-lc", command], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })

      const completed = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]) as Promise<[string, string, number]>
      void completed.catch(() => {
      })

      let progressTimer: ReturnType<typeof setInterval> | null = null
      if (value.onProgress) {
        const onProgress = value.onProgress
        const label = description ? `${description}` : "Running..."
        progressTimer = setInterval(() => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          onProgress(description ? `${label} ${elapsed}s` : `Running... ${elapsed}s`)
        }, 1000)
      }

      let onAbort: (() => void) | null = null
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      let timedOut = false

      const execution = signal
        ? Promise.race([
            completed,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => {
                void (async () => {
                  try {
                    await terminateProcess(proc)
                  } catch {
                    void 0
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

      const effectiveTimeout = timeout ?? 120_000
      const timeoutExecution = Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            void (async () => {
              try {
                await terminateProcess(proc)
              } catch {
                void 0
              }

              reject(new Error(`Shell command timeout: exceeded ${effectiveTimeout}ms`))
            })()
          }, effectiveTimeout)
        }),
      ])

      try {
        const [stdout, stderr, exitCode] = await timeoutExecution
        const durationMs = Date.now() - startTime
        const rawOutput = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")
        const { capped, truncated } = applyOutputCap(rawOutput)

        const metadata = { exitCode, durationMs, truncated }

        if (timedOut) {
          return {
            output: `Shell command timeout: exceeded ${effectiveTimeout}ms`,
            isError: true,
            metadata: { exitCode, durationMs, truncated },
          }
        }

        if (exitCode !== 0) {
          return {
            output: capped || `Shell command failed with exit code ${exitCode}`,
            isError: true,
            metadata,
          }
        }

        return { output: capped, metadata }
      } catch (err) {
        if (progressTimer !== null) {
          clearInterval(progressTimer)
          progressTimer = null
        }
        if (timedOut) {
          const durationMs = Date.now() - startTime
          return {
            output: (err as Error).message,
            isError: true,
            metadata: { exitCode: -1, durationMs, truncated: false },
          }
        }
        throw err
      } finally {
        if (progressTimer !== null) {
          clearInterval(progressTimer)
        }

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
