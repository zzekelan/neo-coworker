import { join } from "node:path"
import { z } from "zod"
import { type ToolDefinition } from "../../domain"
import {
  listWorkspaceFiles,
  truncateWorkspaceMatches,
} from "./workspace-files"

const GrepArgsSchema = z.object({
  query: z.string().trim().min(1, "Query must not be empty"),
})

export function createGrepTool(): ToolDefinition {
  return {
    name: "grep",
    description: "Search literal text across workspace files",
    inputSchema: GrepArgsSchema,
    async execute(input) {
      const { query } = GrepArgsSchema.parse(input.args)
      const files = await listWorkspaceFiles({
        workspaceRoot: input.workspaceRoot,
        signal: input.signal,
      })
      const matches: string[] = []

      for (const relativePath of files) {
        const text = await Bun.file(join(input.workspaceRoot, relativePath)).text()
        const lines = text.split(/\r?\n/g)

        for (const [index, line] of lines.entries()) {
          if (line.includes(query)) {
            matches.push(`${relativePath}:${index + 1}: ${line.trim()}`)
          }
        }
      }

      return {
        output: truncateWorkspaceMatches(matches).join("\n"),
      }
    },
  }
}
