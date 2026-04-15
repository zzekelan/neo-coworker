import { createHash } from "node:crypto"
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import type { ToolObserverPort } from "../application/ports/tool-observer"

const TOOL_RESULTS_DIRECTORY = ".ncoworker/tool-results"
export const DEFAULT_RESULT_STORE_TTL_MS = 24 * 60 * 60 * 1_000

export type ResultStoreSaveResult = {
  path: string
  deduplicated: boolean
}

export type ResultStore = {
  save(content: string, toolName: string, hash?: string): ResultStoreSaveResult | undefined
  load(path: string): string | null
  cleanup(olderThan?: Date): number
}

export type CreateResultStoreInput = {
  workspaceRoot: string
  basePath?: string
  ttlMs?: number
  now?: () => Date
  observer?: ToolObserverPort
  sessionId?: string
  runId?: string
}

export function createResultStore(input: CreateResultStoreInput): ResultStore {
  const basePath = normalizeRelativePath(input.basePath ?? TOOL_RESULTS_DIRECTORY)
  const workspaceRoot = resolve(input.workspaceRoot)
  const baseDirectory = resolve(workspaceRoot, basePath)
  const ttlMs = input.ttlMs ?? DEFAULT_RESULT_STORE_TTL_MS
  const now = input.now ?? (() => new Date())

  function save(content: string, toolName: string, hash = createContentHash(content)) {
    try {
      const safeToolName = normalizeToolName(toolName)
      const savedPath = `${basePath}/${safeToolName}/${hash}.txt`
      const absolutePath = resolveWithinBase(baseDirectory, workspaceRoot, savedPath)
      const createdAt = now()
      const deduplicated = existsSync(absolutePath)

      mkdirSync(dirname(absolutePath), { recursive: true })

      if (deduplicated) {
        utimesSync(absolutePath, createdAt, createdAt)
      } else {
        writeFileSync(absolutePath, content, "utf8")
      }

      emitPersistedEvent({
        observer: input.observer,
        sessionId: input.sessionId,
        runId: input.runId,
        toolName: safeToolName,
        contentSize: Buffer.byteLength(content, "utf8"),
        path: savedPath,
        deduplicated,
      })

      return {
        path: savedPath,
        deduplicated,
      }
    } catch {
      return undefined
    }
  }

  function load(path: string) {
    try {
      const absolutePath = resolveWithinBase(baseDirectory, workspaceRoot, path)
      return readFileSync(absolutePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null
      }

      return null
    }
  }

  function cleanup(olderThan = new Date(now().getTime() - ttlMs)) {
    const cutoff = olderThan.getTime()
    let removed = 0

    let toolDirectories: Dirent[]
    try {
      toolDirectories = readdirSync(baseDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0
      }

      return 0
    }

    for (const toolDirectory of toolDirectories) {
      if (!toolDirectory.isDirectory()) {
        continue
      }

      const absoluteToolDirectory = resolve(baseDirectory, toolDirectory.name)
      const files = readdirSync(absoluteToolDirectory, { withFileTypes: true })

      for (const file of files) {
        if (!file.isFile()) {
          continue
        }

        const absolutePath = resolve(absoluteToolDirectory, file.name)
        const fileStats = statSync(absolutePath)

        if (fileStats.mtime.getTime() >= cutoff) {
          continue
        }

        rmSync(absolutePath, { force: true })
        removed += 1
      }

      if (readdirSync(absoluteToolDirectory).length === 0) {
        rmSync(absoluteToolDirectory, { recursive: true, force: true })
      }
    }

    if (existsSync(baseDirectory) && readdirSync(baseDirectory).length === 0) {
      rmSync(baseDirectory, { recursive: true, force: true })
    }

    return removed
  }

  return {
    save,
    load,
    cleanup,
  }
}

function createContentHash(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

function normalizeRelativePath(path: string) {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "")
}

function normalizeToolName(toolName: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(toolName)) {
    throw new Error(`Invalid tool name for result store: ${toolName}`)
  }

  return toolName
}

function resolveWithinBase(baseDirectory: string, workspaceRoot: string, path: string) {
  const absolutePath = resolve(workspaceRoot, path)
  const relativePath = relative(baseDirectory, absolutePath)

  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".."
  ) {
    throw new Error(`Result path must stay inside ${baseDirectory}: ${path}`)
  }

  return absolutePath
}

function emitPersistedEvent(input: {
  observer?: ToolObserverPort
  sessionId?: string
  runId?: string
  toolName: string
  contentSize: number
  path: string
  deduplicated: boolean
}) {
  if (!input.observer || !input.sessionId || !input.runId) {
    return
  }

  try {
    input.observer.recordToolEvent?.({
      type: "budget.persisted_to_disk",
      sessionId: input.sessionId,
      runId: input.runId,
      toolName: input.toolName,
      contentSize: input.contentSize,
      path: input.path,
      deduplicated: input.deduplicated,
    })
  } catch {}
}
