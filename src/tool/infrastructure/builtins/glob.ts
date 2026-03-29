import { z } from "zod"
import { type ToolDefinition } from "../../domain"
import {
  listWorkspaceFiles,
  truncateWorkspaceMatches,
} from "./workspace-files"

const GlobArgsSchema = z.object({
  pattern: z.string().trim().min(1, "Pattern must not be empty"),
})

export function createGlobTool(): ToolDefinition {
  return {
    name: "glob",
    description: "Find workspace files by glob pattern",
    inputSchema: GlobArgsSchema,
    async execute(input) {
      const { pattern } = GlobArgsSchema.parse(input.args)
      const matches = await listWorkspaceFiles({
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
        pattern,
      })

      return {
        output: truncateWorkspaceMatches(matches).join("\n"),
      }
    },
  }
}
