import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import type { PermissionCoordinator } from "../permissions"
import type { ToolDefinition } from "./types"

const ShellArgsSchema = z.object({
  command: z.string().trim().min(1, "Command must not be empty"),
})

export function createShellTool({
  permissions,
}: {
  permissions: PermissionCoordinator
}): ToolDefinition {
  return {
    name: "shell",
    description: "Run a shell command inside the workspace",
    inputSchema: ShellArgsSchema,
    async execute(input) {
      const { command } = ShellArgsSchema.parse(input.args)
      const decision = await permissions.request({
        toolName: "shell",
        reason: `shell ${command}`,
      })

      if (decision.decision !== "allow") {
        throw new Error("Permission denied")
      }

      const cwd = await realpath(resolve(input.workspaceRoot))
      const process = Bun.spawn(["bash", "-lc", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")

      if (exitCode !== 0) {
        throw new Error(output || `Shell command failed with exit code ${exitCode}`)
      }

      return { output }
    },
  }
}
