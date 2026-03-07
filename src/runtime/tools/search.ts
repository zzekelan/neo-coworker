import { readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { z } from "zod"
import type { ToolDefinition } from "./types"

const SearchArgsSchema = z.object({
  query: z.string(),
})

async function collectFiles(workspaceRoot: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(workspaceRoot, entryPath)))
      continue
    }

    if (entry.isFile()) {
      files.push(relative(workspaceRoot, entryPath))
    }
  }

  return files
}

export function createSearchTool(): ToolDefinition {
  return {
    name: "search",
    description: "Search text across workspace files",
    inputSchema: SearchArgsSchema,
    async execute(input) {
      const { query } = SearchArgsSchema.parse(input.args)
      const workspaceRoot = resolve(input.workspaceRoot)
      const files = await collectFiles(workspaceRoot, workspaceRoot)
      const matches: string[] = []

      for (const relativePath of files) {
        const text = await Bun.file(join(workspaceRoot, relativePath)).text()
        const lines = text.split(/\r?\n/g)

        for (const [index, line] of lines.entries()) {
          if (line.includes(query)) {
            matches.push(`${relativePath}:${index + 1}: ${line.trim()}`)
          }
        }
      }

      return { output: matches.join("\n") }
    },
  }
}
