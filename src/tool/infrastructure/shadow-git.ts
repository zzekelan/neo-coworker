import { realpath, stat } from "node:fs/promises"
import type { ToolObserverEvent, ToolObserverPort } from "../application/ports/tool-observer"
import type { Checkpoint, CheckpointStore } from "../domain"

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

const CHECKPOINT_MESSAGE_PREFIX = "checkpoint: "
const DEFAULT_GIT_TIMEOUT_MS = 15_000
const STASH_FIELD_SEPARATOR = "\u001f"
const STASH_HASH_PATTERN = /^[0-9a-f]{4,64}$/iu
const STASH_REF_PATTERN = /^stash@\{(?<index>\d+)\}$/u
const FULL_STASH_REF_PATTERN = /^refs\/stash@\{(?<index>\d+)\}$/u
const LEADING_CHECKPOINT_PREFIX_PATTERN = /^checkpoint:\s*/iu
const CONTROL_CHARACTER_PATTERN = new RegExp("[\\x00-\\x1f\\x7f]+", "g")
const NO_CHANGES_PATTERN = /\bno local changes to save\b/iu

export type ShadowGitCheckpointErrorCode =
  | "directory_not_found"
  | "not_a_directory"
  | "not_a_git_repository"
  | "git_unavailable"
  | "git_timeout"
  | "invalid_description"
  | "invalid_checkpoint_id"
  | "invalid_stash_ref"
  | "no_changes"
  | "checkpoint_not_found"
  | "create_failed"
  | "restore_failed"
  | "prune_failed"

export class ShadowGitCheckpointError extends Error {
  readonly code: ShadowGitCheckpointErrorCode

  constructor(message: string, code: ShadowGitCheckpointErrorCode) {
    super(message)
    this.name = "ShadowGitCheckpointError"
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

type CheckpointToolObserverEvent = Extract<
  ToolObserverEvent,
  { type: "checkpoint.created" | "checkpoint.restored" | "checkpoint.pruned" }
>

type CheckpointToolObserverEventInput =
  | Omit<Extract<CheckpointToolObserverEvent, { type: "checkpoint.created" }>, "sessionId" | "runId">
  | Omit<Extract<CheckpointToolObserverEvent, { type: "checkpoint.restored" }>, "sessionId" | "runId">
  | Omit<Extract<CheckpointToolObserverEvent, { type: "checkpoint.pruned" }>, "sessionId" | "runId">

export type CreateShadowGitCheckpointStoreInput = {
  observer?: ToolObserverPort
  observerContext?: {
    sessionId: string
    runId: string
  }
  timeoutMs?: number
}

type GitCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export function createShadowGitCheckpointStore(
  input: CreateShadowGitCheckpointStoreInput = {},
): CheckpointStore {
  const timeoutMs = input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS

  async function create(workDir: string, description: string) {
    const repoRoot = await resolveRepositoryRoot(workDir, timeoutMs)
    const safeDescription = normalizeCheckpointDescription(description)
    const previousCheckpoints = await listCheckpoints(repoRoot, timeoutMs)
    const previousIds = new Set(previousCheckpoints.map((checkpoint) => checkpoint.id))
    const stashResult = await runGit(
      repoRoot,
      [
        "stash",
        "push",
        "--include-untracked",
        "--message",
        `${CHECKPOINT_MESSAGE_PREFIX}${safeDescription}`,
      ],
      timeoutMs,
    )

    if (stashResult.exitCode !== 0) {
      throw createGitCommandError("create checkpoint", repoRoot, stashResult, "create_failed")
    }

    const checkpoints = await listCheckpoints(repoRoot, timeoutMs)
    const createdCheckpoint =
      checkpoints.find(
        (checkpoint) =>
          !previousIds.has(checkpoint.id) && checkpoint.description === safeDescription,
      ) ?? checkpoints.find((checkpoint) => !previousIds.has(checkpoint.id))

    if (!createdCheckpoint) {
      if (NO_CHANGES_PATTERN.test(`${stashResult.stdout}\n${stashResult.stderr}`)) {
        throw new ShadowGitCheckpointError(
          `No local changes available to checkpoint in ${repoRoot}`,
          "no_changes",
        )
      }

      throw new ShadowGitCheckpointError(
        `Git stash did not create a checkpoint in ${repoRoot}`,
        "create_failed",
      )
    }

    const applyResult = await runGit(
      repoRoot,
      ["stash", "apply", "--index", stashRefToGitArg(createdCheckpoint.stashRef)],
      timeoutMs,
    )

    if (applyResult.exitCode !== 0) {
      throw createGitCommandError(
        `re-apply checkpoint ${createdCheckpoint.stashRef} after creation`,
        repoRoot,
        applyResult,
        "create_failed",
      )
    }

    emitToolEvent(input, {
      type: "checkpoint.created",
      payload: {
        description: createdCheckpoint.description,
        stashRef: createdCheckpoint.stashRef,
      },
    })

    return createdCheckpoint
  }

  async function restore(workDir: string, checkpointId: string) {
    const repoRoot = await resolveRepositoryRoot(workDir, timeoutMs)
    const checkpoints = await listCheckpoints(repoRoot, timeoutMs)
    const checkpoint = findCheckpoint(checkpoints, checkpointId)

    if (!checkpoint) {
      throw new ShadowGitCheckpointError(
        `Checkpoint not found: ${checkpointId}`,
        "checkpoint_not_found",
      )
    }

    const resetResult = await runGit(repoRoot, ["reset", "--hard", "HEAD"], timeoutMs)
    if (resetResult.exitCode !== 0) {
      throw createGitCommandError(
        `prepare repository for restoring ${checkpoint.stashRef}`,
        repoRoot,
        resetResult,
        "restore_failed",
      )
    }

    const cleanResult = await runGit(repoRoot, ["clean", "-fd"], timeoutMs)
    if (cleanResult.exitCode !== 0) {
      throw createGitCommandError(
        `clean repository before restoring ${checkpoint.stashRef}`,
        repoRoot,
        cleanResult,
        "restore_failed",
      )
    }

    const applyResult = await runGit(
      repoRoot,
      ["stash", "apply", "--index", stashRefToGitArg(checkpoint.stashRef)],
      timeoutMs,
    )

    if (applyResult.exitCode !== 0) {
      throw createGitCommandError(
        `restore checkpoint ${checkpoint.stashRef}`,
        repoRoot,
        applyResult,
        "restore_failed",
      )
    }

    emitToolEvent(input, {
      type: "checkpoint.restored",
      payload: {
        stashRef: checkpoint.stashRef,
      },
    })
  }

  async function list(workDir: string) {
    const repoRoot = await resolveRepositoryRoot(workDir, timeoutMs)
    return listCheckpoints(repoRoot, timeoutMs)
  }

  async function prune(workDir: string, keepLast: number) {
    if (!Number.isInteger(keepLast) || keepLast < 0) {
      throw new ShadowGitCheckpointError(
        `keepLast must be a non-negative integer, received ${keepLast}`,
        "invalid_checkpoint_id",
      )
    }

    const repoRoot = await resolveRepositoryRoot(workDir, timeoutMs)
    const checkpoints = await listCheckpoints(repoRoot, timeoutMs)
    const checkpointsToDrop = checkpoints
      .slice(keepLast)
      .sort((left, right) => stashRefIndex(right.stashRef) - stashRefIndex(left.stashRef))

    let prunedCount = 0
    for (const checkpoint of checkpointsToDrop) {
      const dropResult = await runGit(
        repoRoot,
        ["stash", "drop", stashRefToGitArg(checkpoint.stashRef)],
        timeoutMs,
      )

      if (dropResult.exitCode !== 0) {
        throw createGitCommandError(
          `prune checkpoint ${checkpoint.stashRef}`,
          repoRoot,
          dropResult,
          "prune_failed",
        )
      }

      prunedCount += 1
    }

    const remainingCount = (await listCheckpoints(repoRoot, timeoutMs)).length
    emitToolEvent(input, {
      type: "checkpoint.pruned",
      payload: {
        prunedCount,
        remainingCount,
      },
    })

    return prunedCount
  }

  return {
    create,
    restore,
    list,
    prune,
  }
}

async function resolveRepositoryRoot(workDir: string, timeoutMs: number) {
  const directory = await resolveDirectory(workDir)
  const result = await runGit(directory, ["rev-parse", "--show-toplevel"], timeoutMs)

  if (result.exitCode !== 0) {
    throw new ShadowGitCheckpointError(
      `Checkpoint store requires a git repository: ${directory}`,
      "not_a_git_repository",
    )
  }

  return realpath(result.stdout.trim())
}

async function resolveDirectory(workDir: string) {
  let resolvedDirectory: string
  try {
    resolvedDirectory = await realpath(workDir)
  } catch {
    throw new ShadowGitCheckpointError(`Checkpoint directory not found: ${workDir}`, "directory_not_found")
  }

  const directoryStats = await stat(resolvedDirectory)
  if (!directoryStats.isDirectory()) {
    throw new ShadowGitCheckpointError(
      `Checkpoint path must be a directory: ${resolvedDirectory}`,
      "not_a_directory",
    )
  }

  return resolvedDirectory
}

async function listCheckpoints(workDir: string, timeoutMs: number) {
  const result = await runGit(
    workDir,
    ["stash", "list", `--format=%H${STASH_FIELD_SEPARATOR}%ct${STASH_FIELD_SEPARATOR}%gd${STASH_FIELD_SEPARATOR}%gs`],
    timeoutMs,
  )

  if (result.exitCode !== 0) {
    throw createGitCommandError("list checkpoints", workDir, result, "restore_failed")
  }

  if (result.stdout.length === 0) {
    return []
  }

  return result.stdout
    .split(/\r?\n/u)
    .map(parseCheckpointLine)
    .filter((checkpoint): checkpoint is Checkpoint => checkpoint !== null)
}

function parseCheckpointLine(line: string): Checkpoint | null {
  if (line.trim().length === 0) {
    return null
  }

  const [id, timestampSeconds, rawStashRef, ...subjectParts] = line.split(STASH_FIELD_SEPARATOR)
  const subject = subjectParts.join(STASH_FIELD_SEPARATOR)
  if (!id || !timestampSeconds || !rawStashRef || !STASH_HASH_PATTERN.test(id)) {
    return null
  }

  const timestamp = Number(timestampSeconds)
  if (!Number.isFinite(timestamp)) {
    return null
  }

  const stashRef = normalizeListedStashRef(rawStashRef)
  if (!stashRef) {
    return null
  }

  const description = parseCheckpointDescription(subject)
  if (!description) {
    return null
  }

  return {
    id,
    timestamp: new Date(timestamp * 1_000),
    description,
    stashRef,
  }
}

function parseCheckpointDescription(subject: string) {
  const trimmedSubject = subject.trim()
  const prefixedSubject = trimmedSubject.match(/^(?:On|WIP on) [^:]+: (.*)$/u)
  const message = prefixedSubject?.[1] ?? trimmedSubject

  if (!message.startsWith(CHECKPOINT_MESSAGE_PREFIX)) {
    return null
  }

  const description = message.slice(CHECKPOINT_MESSAGE_PREFIX.length).trim()
  return description.length > 0 ? description : null
}

function normalizeCheckpointDescription(description: string) {
  const normalized = description
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .trim()
    .replace(LEADING_CHECKPOINT_PREFIX_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200)

  if (normalized.length === 0) {
    throw new ShadowGitCheckpointError(
      "Checkpoint description must contain visible characters",
      "invalid_description",
    )
  }

  return normalized
}

function findCheckpoint(checkpoints: Checkpoint[], checkpointId: string) {
  const normalizedCheckpointId = checkpointId.trim()
  if (normalizedCheckpointId.length === 0) {
    throw new ShadowGitCheckpointError(
      "Checkpoint id must not be empty",
      "invalid_checkpoint_id",
    )
  }

  if (
    normalizedCheckpointId.startsWith("stash@") ||
    normalizedCheckpointId.startsWith("refs/stash@")
  ) {
    const stashRef = normalizeInputStashRef(normalizedCheckpointId)
    return checkpoints.find((checkpoint) => checkpoint.stashRef === stashRef)
  }

  return checkpoints.find((checkpoint) => checkpoint.id === normalizedCheckpointId)
}

function normalizeListedStashRef(stashRef: string) {
  const trimmedStashRef = stashRef.trim()
  const match = trimmedStashRef.match(STASH_REF_PATTERN)
  if (!match) {
    return null
  }

  return `refs/${trimmedStashRef}`
}

function normalizeInputStashRef(stashRef: string) {
  const trimmedStashRef = stashRef.trim()
  if (FULL_STASH_REF_PATTERN.test(trimmedStashRef)) {
    return trimmedStashRef
  }

  if (STASH_REF_PATTERN.test(trimmedStashRef)) {
    return `refs/${trimmedStashRef}`
  }

  throw new ShadowGitCheckpointError(
    `Invalid stash reference: ${stashRef}`,
    "invalid_stash_ref",
  )
}

function stashRefToGitArg(stashRef: string) {
  return normalizeInputStashRef(stashRef).slice("refs/".length)
}

function stashRefIndex(stashRef: string) {
  const normalized = normalizeInputStashRef(stashRef)
  const match = normalized.match(FULL_STASH_REF_PATTERN)

  if (!match?.groups?.index) {
    throw new ShadowGitCheckpointError(
      `Invalid stash reference: ${stashRef}`,
      "invalid_stash_ref",
    )
  }

  return Number(match.groups.index)
}

function emitToolEvent(
  input: CreateShadowGitCheckpointStoreInput,
  event: CheckpointToolObserverEventInput,
) {
  const sessionId = input.observerContext?.sessionId
  const runId = input.observerContext?.runId
  if (!input.observer || !sessionId || !runId) {
    return
  }

  try {
    switch (event.type) {
      case "checkpoint.created":
        input.observer.recordToolEvent?.({
          sessionId,
          runId,
          type: event.type,
          payload: event.payload,
        })
        break
      case "checkpoint.restored":
        input.observer.recordToolEvent?.({
          sessionId,
          runId,
          type: event.type,
          payload: event.payload,
        })
        break
      case "checkpoint.pruned":
        input.observer.recordToolEvent?.({
          sessionId,
          runId,
          type: event.type,
          payload: event.payload,
        })
        break
    }
  } catch {}
}

async function runGit(workDir: string, args: string[], timeoutMs: number): Promise<GitCommandResult> {
  let process: ReturnType<typeof Bun.spawn>
  try {
    process = Bun.spawn(["git", ...args], {
      cwd: workDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    throw new ShadowGitCheckpointError("Git executable is not available", "git_unavailable")
  }

  const completed = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]) as Promise<[string, string, number]>

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          try {
            process.kill("SIGKILL")
          } catch {
            void 0
          }

          reject(
            new ShadowGitCheckpointError(
              `Git command timed out after ${timeoutMs}ms: git ${args.join(" ")}`,
              "git_timeout",
            ),
          )
        }, timeoutMs)
      }),
    ])

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    }
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
  }
}

function createGitCommandError(
  action: string,
  workDir: string,
  result: GitCommandResult,
  code: Extract<ShadowGitCheckpointErrorCode, "create_failed" | "restore_failed" | "prune_failed">,
) {
  const details = result.stderr || result.stdout || `git exited with code ${result.exitCode}`
  return new ShadowGitCheckpointError(
    `Failed to ${action} in ${workDir}: ${details}`,
    code,
  )
}
