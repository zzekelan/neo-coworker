import { access } from "node:fs/promises"
import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  assertWorkspacePathNotReserved,
  isWorkspacePathInAllowedNcoworkerSubtree,
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"
import { type AtomicUtf8FileWrite, withSerializedFileMutation, writeUtf8FileAtomically } from "./mutating-file"

const CONDITIONALLY_PROTECTED_WRITE_BASENAMES = new Set([
  "readme.md",
  "agents.md",
  "claude.md",
  "package.json",
  "tsconfig.json",
  "bun.lock",
  "bun.lockb",
])

const WriteArgsSchema = z.object({
  path: z.string().trim().min(1, "Path must not be empty").describe(
    "Workspace-relative file path to create or overwrite, for example `notes/todo.md` or `src/example.ts`. Parent directories are created automatically if they do not exist. Existing files are normally overwritten atomically, but protected files such as `README.md`, `AGENTS.md`, `package.json`, `tsconfig.json`, `bun.lock`, and `.env*` require a read-first confirmation before overwrite.",
  ),
  content: z.string().describe(
    "Complete UTF-8 file contents to write. Pass the full desired file body, not a patch or partial replacement. The entire file is replaced atomically.",
  ),
}).describe(
  "Create or overwrite a UTF-8 file inside the workspace. Use this when you need to write a full file from scratch or replace the entire contents in one step; prefer `edit` when you only need to change one exact span in an existing file. Parent directories are created automatically. Writes are performed atomically to prevent partial content on interruption. Normal overwrites are allowed, but protected files require a read-first confirmation before overwrite. This tool requires permission because it mutates workspace state. Paths must stay inside the workspace.",
)

function isConditionallyProtectedWritePath(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean)
  const name = (segments.at(-1) ?? relativePath).toLowerCase()
  return CONDITIONALLY_PROTECTED_WRITE_BASENAMES.has(name) || name === ".env" || name.startsWith(".env.")
}

function assertWorkspaceParentPathAllowedForWrite(relativePath: string, targetRelativePath: string) {
  if (
    relativePath === ".ncoworker" &&
    isWorkspacePathInAllowedNcoworkerSubtree(targetRelativePath)
  ) {
    return
  }

  assertWorkspacePathNotReserved(relativePath)
}

async function resolveWorkspaceWritePath(workspaceRoot: string, relativePath: string) {
  assertWorkspacePathNotReserved(relativePath)

  const root = await realpath(resolve(workspaceRoot))
  const target = resolve(root, relativePath)
  const resolvedTargetRelativePath = relative(root, target)
  assertWorkspacePathNotReserved(resolvedTargetRelativePath)

  if (target === root) {
    throw new Error(`Path must reference a file inside workspace: ${relativePath}`)
  }

  try {
    const existing = await realpath(target)

    if (existing !== root && !existing.startsWith(`${root}${sep}`)) {
      throw new Error(`Path must stay inside workspace: ${relativePath}`)
    }

    assertWorkspacePathNotReserved(relative(root, existing))

    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }

    const pathSegments = relativePath.replaceAll("\\", "/").split("/").filter(Boolean)
    const fileName = pathSegments.at(-1)
    if (!fileName) {
      throw new Error(`Path must reference a file inside workspace: ${relativePath}`)
    }

    const parentSegments = pathSegments.slice(0, -1)
    let existingParentDir = root
    let firstMissingIndex = parentSegments.length

    for (const [index, segment] of parentSegments.entries()) {
      const candidate = resolve(existingParentDir, segment)

      try {
        const resolvedCandidate = await realpath(candidate)
        if (resolvedCandidate !== root && !resolvedCandidate.startsWith(`${root}${sep}`)) {
          throw new Error(`Path must stay inside workspace: ${relativePath}`)
        }

        const relativeCandidate = relative(root, resolvedCandidate)
        if (relativeCandidate) {
          assertWorkspaceParentPathAllowedForWrite(relativeCandidate, relativePath)
        }

        existingParentDir = resolvedCandidate
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw parentError
        }

        firstMissingIndex = index
        break
      }
    }

    for (const segment of parentSegments.slice(firstMissingIndex)) {
      existingParentDir = resolve(existingParentDir, segment)
    }

    if (existingParentDir !== root && !existingParentDir.startsWith(`${root}${sep}`)) {
      throw new Error(`Path must stay inside workspace: ${relativePath}`)
    }

    const relativeParent = relative(root, existingParentDir)
    if (relativeParent) {
      assertWorkspaceParentPathAllowedForWrite(relativeParent, relativePath)
    }

    const resolvedTarget = resolve(existingParentDir, fileName)
    if (resolvedTarget === root || !resolvedTarget.startsWith(`${existingParentDir}${sep}`)) {
      throw new Error(`Path must stay inside workspace: ${relativePath}`)
    }

    return resolvedTarget
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export function createWriteTool(input: {
  requestPermission: RequestToolPermission
  atomicWrite?: AtomicUtf8FileWrite
}): ToolDefinition {
  const atomicWrite = input.atomicWrite ?? writeUtf8FileAtomically

  return {
    name: "write",
    description:
      "Create or overwrite a UTF-8 file inside the workspace. Use this when you need to write a full file from scratch or replace the entire contents in one step; prefer `edit` when you only need to change one exact span in an existing file. Parent directories are created automatically. Writes are performed atomically to prevent partial content on interruption. Normal overwrites are allowed, but protected files require a read-first confirmation before overwrite. This tool requires permission because it mutates workspace state. Paths must stay inside the workspace.",
    inputSchema: WriteArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    usageGuidance:
      "Prefer `edit` for targeted changes. Use `write` for new files or full rewrites. Read protected files such as README.md, AGENTS.md, package.json, tsconfig.json, bun.lock, and .env* before overwriting them. Do not add emojis unless the user asks for them.",
    async execute(value) {
      throwIfToolAborted(value.signal)
      const { path, content } = WriteArgsSchema.parse(value.args)
      assertWorkspacePathNotReserved(path)
      const decision = await input.requestPermission({
        toolName: "write",
        reason: `write ${path}`,
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(value.signal)
      const file = await resolveWorkspaceWritePath(value.workspaceRoot, path)
      throwIfToolAborted(value.signal)

      return await withSerializedFileMutation(file, async () => {
        throwIfToolAborted(value.signal)

        if ((await fileExists(file)) && isConditionallyProtectedWritePath(path)) {
          return {
            output: "File exists. Please read it first to confirm overwrite.",
            isError: true,
            metadata: { requiresRead: true },
          }
        }

        throwIfToolAborted(value.signal)
        await atomicWrite(file, content)

        return { output: `Wrote ${path}` }
      })
    },
  }
}
