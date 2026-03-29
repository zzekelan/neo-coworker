import { readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import {
  WORKSPACE_MAX_MATCHES,
  WORKSPACE_SKIPPED_DIRECTORIES,
  throwIfToolAborted,
} from "../../domain"

const WORKSPACE_EXCLUDE_GLOBS = [
  "!.agents/**",
  "!.git/**",
  "!node_modules/**",
  "!.worktrees/**",
  "!**/.agents/**",
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/.worktrees/**",
]

export async function listWorkspaceFiles(input: {
  workspaceRoot: string
  signal?: AbortSignal
  pattern?: string
}) {
  try {
    return await listWorkspaceFilesWithRipgrep(input)
  } catch {
    return await listWorkspaceFilesWithTraversal(input)
  }
}

export function truncateWorkspaceMatches(matches: string[]) {
  if (matches.length <= WORKSPACE_MAX_MATCHES) {
    return matches
  }

  return [...matches.slice(0, WORKSPACE_MAX_MATCHES), `... truncated after ${WORKSPACE_MAX_MATCHES} matches`]
}

async function listWorkspaceFilesWithRipgrep(input: {
  workspaceRoot: string
  signal?: AbortSignal
  pattern?: string
}) {
  throwIfToolAborted(input.signal)

  const args = ["--files", "--hidden"]

  for (const glob of WORKSPACE_EXCLUDE_GLOBS) {
    args.push("--glob", glob)
  }

  if (input.pattern) {
    args.push("-g", input.pattern)
  }

  const process = Bun.spawn(["rg", ...args], {
    cwd: input.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal: input.signal,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])

  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(stderr.trim() || `rg --files exited with code ${exitCode}`)
  }

  return stdout
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter(isWorkspaceFileVisible)
    .sort((left, right) => left.localeCompare(right))
}

async function listWorkspaceFilesWithTraversal(input: {
  workspaceRoot: string
  signal?: AbortSignal
  pattern?: string
}) {
  const workspaceRoot = resolve(input.workspaceRoot)
  const files = await collectFiles(workspaceRoot, workspaceRoot, input.signal)

  if (!input.pattern) {
    return files
  }

  const glob = new Bun.Glob(input.pattern)
  return files.filter((file) => glob.match(file)).filter(isWorkspaceFileVisible)
}

async function collectFiles(
  workspaceRoot: string,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  throwIfToolAborted(signal)
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfToolAborted(signal)
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (WORKSPACE_SKIPPED_DIRECTORIES.has(entry.name)) {
        continue
      }

      files.push(...(await collectFiles(workspaceRoot, entryPath, signal)))
      continue
    }

    if (entry.isFile()) {
      files.push(relative(workspaceRoot, entryPath))
    }
  }

  return files
}

function isWorkspaceFileVisible(file: string) {
  return !file
    .split("/")
    .some((segment) => WORKSPACE_SKIPPED_DIRECTORIES.has(segment))
}
