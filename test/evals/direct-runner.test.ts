import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadEvalTasks, runDiscoveredEvalTasks } from "../../evals"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("direct eval runner", () => {
  test("runs the default regression catalog and persists artifact bundles", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-direct-"))
    tempDirectories.push(outputRoot)

    const tasks = await loadEvalTasks()
    expect(tasks.map((task) => task.id)).toEqual([
      "regression/cancel-after-output",
      "regression/permission-allow-write",
      "regression/permission-deny-write",
      "regression/read-only",
      "regression/retry-recovery",
    ])

    const suite = await runDiscoveredEvalTasks({
      outputRoot,
    })

    expect(suite.pass).toBe(true)
    expect(suite.results).toHaveLength(5)

    const resultsById = new Map(suite.results.map((entry) => [entry.task.id, entry]))

    expect(resultsById.get("regression/retry-recovery")?.result.artifact.metrics.retryCount).toBe(1)
    expect(
      resultsById.get("regression/permission-allow-write")?.result.artifact.outcome.watchedFiles,
    ).toEqual([
      expect.objectContaining({
        path: "notes.txt",
        exists: true,
        content: expect.stringContaining("hello from eval allow"),
      }),
    ])
    expect(
      resultsById.get("regression/permission-deny-write")?.result.artifact.outcome.watchedFiles,
    ).toEqual([
      expect.objectContaining({
        path: "notes.txt",
        exists: false,
        content: null,
      }),
    ])

    const readOnlyTrace = await Bun.file(
      join(resultsById.get("regression/read-only")!.artifactDir, "trace.json"),
    ).json()
    expect(readOnlyTrace).toMatchObject({
      runId: expect.any(String),
      events: expect.any(Array),
    })

    const cancelGraders = await Bun.file(
      join(resultsById.get("regression/cancel-after-output")!.artifactDir, "grader-results.json"),
    ).json()
    expect(cancelGraders).toMatchObject({
      pass: true,
      grades: {
        protocol: {
          pass: true,
        },
      },
    })
  })
})
