import { mkdir, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import {
  buildKnowledgeAssetDirectory,
  buildKnowledgeAssetFileName,
  type KnowledgeAssetKind,
} from "../domain"
import type { KnowledgeStoragePort } from "../application"

export function createKnowledgeFileStorage(): KnowledgeStoragePort {
  return {
    async writeAssetFile(input) {
      const workspaceRoot = await resolveWorkspaceRoot(input.workspaceRoot)
      const directory = join(
        workspaceRoot,
        ".agents",
        "research",
        buildKnowledgeAssetDirectory(input.kind),
      )
      await mkdir(directory, { recursive: true })
      const fileName = buildKnowledgeAssetFileName({
        assetId: input.assetId,
        title: input.title,
        kind: input.kind,
      })
      const absolutePath = join(directory, fileName)
      const relativePath = relative(workspaceRoot, absolutePath)
      const content = renderAssetFile(input)
      await Bun.write(absolutePath, content)

      return {
        path: relativePath,
      }
    },
    async readAssetFile(input) {
      const workspaceRoot = await resolveWorkspaceRoot(input.workspaceRoot)
      const absolutePath = resolve(workspaceRoot, input.path)
      const parent = await realpath(dirname(absolutePath))

      if (parent !== workspaceRoot && !parent.startsWith(`${workspaceRoot}${sep}`)) {
        throw new Error(`Path must stay inside workspace: ${input.path}`)
      }

      return Bun.file(absolutePath).text()
    },
  }
}

async function resolveWorkspaceRoot(workspaceRoot: string) {
  return realpath(resolve(workspaceRoot))
}

function renderAssetFile(input: {
  kind: KnowledgeAssetKind
  title: string
  content: string
  sourceUrl?: string | null
  createdAt: number
}) {
  const headerLines = [`# ${input.title}`]

  if (input.sourceUrl) {
    headerLines.push(`Source URL: ${input.sourceUrl}`)
  }

  headerLines.push(`Saved At: ${new Date(input.createdAt).toISOString()}`)

  return `${headerLines.join("\n")}\n\n---\n\n${input.content.trim()}\n`
}
