import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CHECKPOINT_TRIGGERS,
  shouldCheckpoint,
  type Checkpoint,
  type CheckpointStore,
} from "../../src/tool"
import {
  createShadowGitCheckpointStore,
  ShadowGitCheckpointError,
} from "../../src/tool/infrastructure/shadow-git"

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

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("shadow git checkpoint triggers", () => {
  test("exports the supported checkpoint trigger tool names", () => {
    expect(CHECKPOINT_TRIGGERS).toEqual(["write", "edit", "patch", "shell"])
  })

  test("write triggers checkpoint", () => {
    expect(shouldCheckpoint("write", { path: "notes.txt", content: "hello" })).toBe(true)
  })

  test("edit triggers checkpoint", () => {
    expect(
      shouldCheckpoint("edit", {
        path: "notes.txt",
        operation: "replace",
        start: "L1#ca978112|a",
        content: "b",
      }),
    ).toBe(true)
  })

  test("patch triggers checkpoint", () => {
    expect(shouldCheckpoint("patch", { patch: "*** Begin Patch" })).toBe(true)
  })

  test("read does not trigger checkpoint", () => {
    expect(shouldCheckpoint("read", { filePath: "notes.txt" })).toBe(false)
  })

  test("destructive shell commands trigger checkpoint", () => {
    expect(shouldCheckpoint("shell", { command: "rm file.txt" })).toBe(true)
  })

  test("benign shell commands do not trigger checkpoint", () => {
    expect(shouldCheckpoint("shell", { command: "ls" })).toBe(false)
  })

  test("shell overwrite redirects trigger checkpoint", () => {
    expect(shouldCheckpoint("shell", { command: "echo hello > file.txt" })).toBe(true)
  })

  test("exports checkpoint domain shapes", async () => {
    const checkpoint: Checkpoint = {
      id: "checkpoint-1",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      description: "before write",
      stashRef: "refs/stash@{0}",
    }

    const store: CheckpointStore = {
      async create() {
        return checkpoint
      },
      async restore() {},
      async list() {
        return [checkpoint]
      },
      async prune() {
        return 1
      },
    }

    expect(await store.create("/tmp/demo", "before write")).toEqual(checkpoint)
    expect(await store.list("/tmp/demo")).toEqual([checkpoint])
    expect(await store.restore("/tmp/demo", checkpoint.id)).toBe(undefined)
    expect(await store.prune("/tmp/demo", 10)).toBe(1)
  })
})

describe("shadow git checkpoint store", () => {
  test("creates, lists, restores, and emits telemetry for stash checkpoints", async () => {
    const workspaceRoot = await createGitWorkspace("shadow-git-create-restore-")
    const events: Array<Record<string, unknown>> = []
    const store = createShadowGitCheckpointStore({
      observerContext: { sessionId: "session_1", runId: "run_1" },
      observer: {
        recordToolEvent(event) {
          events.push(event as unknown as Record<string, unknown>)
        },
      },
    })

    await writeFile(join(workspaceRoot, "notes.txt"), "version 2\n", "utf8")
    await writeFile(join(workspaceRoot, "draft.txt"), "draft\n", "utf8")

    const checkpoint = await store.create(workspaceRoot, "checkpoint: before restore\nnext line")

    expect(checkpoint.description).toBe("before restore next line")
    expect(checkpoint.stashRef).toBe("refs/stash@{0}")

    const checkpoints = await store.list(workspaceRoot)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toEqual(checkpoint)

    await writeFile(join(workspaceRoot, "notes.txt"), "broken\n", "utf8")
    await rm(join(workspaceRoot, "draft.txt"), { force: true })

    await store.restore(workspaceRoot, checkpoint.id)

    await expect(readFile(join(workspaceRoot, "notes.txt"), "utf8")).resolves.toBe("version 2\n")
    await expect(readFile(join(workspaceRoot, "draft.txt"), "utf8")).resolves.toBe("draft\n")
    expect(events).toEqual([
      {
        sessionId: "session_1",
        runId: "run_1",
        type: "checkpoint.created",
        payload: {
          description: "before restore next line",
          stashRef: checkpoint.stashRef,
        },
      },
      {
        sessionId: "session_1",
        runId: "run_1",
        type: "checkpoint.restored",
        payload: {
          stashRef: checkpoint.stashRef,
        },
      },
    ])
  })

  test("prunes older stash checkpoints and emits telemetry", async () => {
    const workspaceRoot = await createGitWorkspace("shadow-git-prune-")
    const events: Array<Record<string, unknown>> = []
    const store = createShadowGitCheckpointStore({
      observerContext: { sessionId: "session_1", runId: "run_1" },
      observer: {
        recordToolEvent(event) {
          events.push(event as unknown as Record<string, unknown>)
        },
      },
    })

    await writeFile(join(workspaceRoot, "notes.txt"), "version 2\n", "utf8")
    const first = await store.create(workspaceRoot, "first")

    await writeFile(join(workspaceRoot, "notes.txt"), "version 3\n", "utf8")
    const second = await store.create(workspaceRoot, "second")

    await writeFile(join(workspaceRoot, "notes.txt"), "version 4\n", "utf8")
    const third = await store.create(workspaceRoot, "third")

    expect((await store.list(workspaceRoot)).map((checkpoint) => checkpoint.description)).toEqual([
      "third",
      "second",
      "first",
    ])

    const prunedCount = await store.prune(workspaceRoot, 2)

    expect(prunedCount).toBe(1)
    const remaining = await store.list(workspaceRoot)
    expect(remaining.map((checkpoint) => checkpoint.description)).toEqual(["third", "second"])
    expect(remaining.find((checkpoint) => checkpoint.id === first.id)).toBeUndefined()
    expect(remaining.find((checkpoint) => checkpoint.id === second.id)).toBeDefined()
    expect(remaining.find((checkpoint) => checkpoint.id === third.id)).toBeDefined()
    expect(events.at(-1)).toEqual({
      sessionId: "session_1",
      runId: "run_1",
      type: "checkpoint.pruned",
      payload: {
        prunedCount: 1,
        remainingCount: 2,
      },
    })
  })

  test("matches checkpoints by stash ref and rejects malformed stash refs", async () => {
    const workspaceRoot = await createGitWorkspace("shadow-git-stash-ref-")
    const store = createShadowGitCheckpointStore()

    await writeFile(join(workspaceRoot, "notes.txt"), "version 2\n", "utf8")
    const checkpoint = await store.create(workspaceRoot, "safe lookup")
    await writeFile(join(workspaceRoot, "notes.txt"), "broken\n", "utf8")

    await store.restore(workspaceRoot, "stash@{0}")
    await expect(readFile(join(workspaceRoot, "notes.txt"), "utf8")).resolves.toBe("version 2\n")

    await expect(store.restore(workspaceRoot, "stash@{0} --index")).rejects.toBeInstanceOf(
      ShadowGitCheckpointError,
    )
    await expect(store.restore(workspaceRoot, "stash@{0} --index")).rejects.toMatchObject({
      code: "invalid_stash_ref",
    })
    await expect(store.restore(workspaceRoot, checkpoint.id.slice(0, 12))).rejects.toMatchObject({
      code: "checkpoint_not_found",
    })
  })

  test("fails gracefully outside git repositories", async () => {
    const workspaceRoot = await createWorkspace("shadow-git-non-git-")
    const store = createShadowGitCheckpointStore()

    await writeFile(join(workspaceRoot, "notes.txt"), "draft\n", "utf8")

    await expect(store.list(workspaceRoot)).rejects.toBeInstanceOf(ShadowGitCheckpointError)
    await expect(store.list(workspaceRoot)).rejects.toMatchObject({ code: "not_a_git_repository" })
    await expect(store.create(workspaceRoot, "draft checkpoint")).rejects.toMatchObject({
      code: "not_a_git_repository",
    })
  })

  test("rejects empty checkpoint descriptions after sanitization", async () => {
    const workspaceRoot = await createGitWorkspace("shadow-git-empty-description-")
    const store = createShadowGitCheckpointStore()

    await writeFile(join(workspaceRoot, "notes.txt"), "version 2\n", "utf8")

    await expect(store.create(workspaceRoot, "\n\tcheckpoint: \u0000 ")).rejects.toBeInstanceOf(
      ShadowGitCheckpointError,
    )
    await expect(store.create(workspaceRoot, "\n\tcheckpoint: \u0000 ")).rejects.toMatchObject({
      code: "invalid_description",
    })
  })
})

async function createWorkspace(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

async function createGitWorkspace(prefix: string) {
  const directory = await createWorkspace(prefix)
  await runGit(directory, ["init"])
  await runGit(directory, ["config", "user.email", "test@example.com"])
  await runGit(directory, ["config", "user.name", "Test User"])
  await writeFile(join(directory, "notes.txt"), "version 1\n", "utf8")
  await runGit(directory, ["add", "notes.txt"])
  await runGit(directory, ["commit", "-m", "initial"])
  return directory
}

async function runGit(workspaceRoot: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd: workspaceRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`)
  }

  return stdout.trim()
}
