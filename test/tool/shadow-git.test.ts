import { describe, expect, test } from "bun:test"
import {
  CHECKPOINT_TRIGGERS,
  shouldCheckpoint,
  type Checkpoint,
  type CheckpointStore,
} from "../../src/tool"

describe("shadow git checkpoint triggers", () => {
  test("exports the supported checkpoint trigger tool names", () => {
    expect(CHECKPOINT_TRIGGERS).toEqual(["write", "edit", "patch", "shell"])
  })

  test("write triggers checkpoint", () => {
    expect(shouldCheckpoint("write", { path: "notes.txt", content: "hello" })).toBe(true)
  })

  test("edit triggers checkpoint", () => {
    expect(shouldCheckpoint("edit", { path: "notes.txt", oldText: "a", newText: "b" })).toBe(true)
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
