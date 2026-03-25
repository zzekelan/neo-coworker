import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type OpenAI from "openai"
import { loadEvalTasks, runDiscoveredEvalTasks } from "../../evals"
import { createModelProvider, createModelRuntimeApi } from "../../src/model"

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
    expect(suite.providerMode).toBe("scripted")
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

  test("loads and runs the live eval catalog through the default provider assembly path", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-live-direct-"))
    tempDirectories.push(outputRoot)
    const openAIConfigs: unknown[] = []

    const tasks = await loadEvalTasks({
      providerMode: "live",
    })
    expect(tasks.map((task) => task.id)).toEqual(["live/read-only"])

    const suite = await runDiscoveredEvalTasks({
      providerMode: "live",
      taskIds: ["live/read-only"],
      outputRoot,
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
      },
      createClient(config) {
        openAIConfigs.push(config)
        return {} as OpenAI
      },
      createOpenAIProviderImpl(input) {
        return createModelProvider({
          observer: input.observer,
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              yield { type: "text.delta", text: "live summary" }
            },
          }),
        })
      },
    })

    expect(openAIConfigs).toEqual([{ apiKey: "test-key", baseURL: undefined, timeout: undefined }])
    expect(suite.pass).toBe(true)
    expect(suite.providerMode).toBe("live")
    expect(suite.results).toHaveLength(1)
    expect(suite.results[0]?.result.artifact.provider).toEqual({
      mode: "live",
      kind: "openai",
      model: "gpt-5",
    })
  })

  test("surfaces live provider execution failures with an explicit operator message", async () => {
    await expect(
      runDiscoveredEvalTasks({
        providerMode: "live",
        taskIds: ["live/read-only"],
        env: {
          LLM_PROVIDER: "openai",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "gpt-5",
        },
        createClient() {
          return {} as OpenAI
        },
        createOpenAIProviderImpl() {
          throw new Error("upstream unavailable")
        },
      }),
    ).rejects.toThrow("Live eval provider execution failed for live/read-only: upstream unavailable")
  })

  test("rejects task workspace fixtures that escape evals/fixtures", async () => {
    const tasksRoot = await mkdtemp(join(tmpdir(), "eval-task-escape-"))
    tempDirectories.push(tasksRoot)
    await mkdir(join(tasksRoot, "regression"), { recursive: true })
    await writeFile(
      join(tasksRoot, "regression", "escape.json"),
      JSON.stringify({
        id: "regression/escape-fixture",
        scenario: "read-only",
        prompt: "escape fixture",
        workspaceFixture: "../outside",
      }),
      "utf8",
    )

    await expect(
      loadEvalTasks({
        tasksRoot,
      }),
    ).rejects.toThrow("must stay inside")
  })

  test("ignores malformed live task documents when loading the default scripted lane", async () => {
    const tasksRoot = await mkdtemp(join(tmpdir(), "eval-live-skip-"))
    tempDirectories.push(tasksRoot)
    await mkdir(join(tasksRoot, "regression"), { recursive: true })
    await mkdir(join(tasksRoot, "live"), { recursive: true })
    await writeFile(
      join(tasksRoot, "regression", "read-only.json"),
      JSON.stringify({
        id: "regression/read-only",
        scenario: "read-only",
        prompt: "read only",
        workspaceFixture: "workspaces/basic",
      }),
      "utf8",
    )
    await writeFile(
      join(tasksRoot, "live", "broken.json"),
      '{ "id": "live/broken", "providerMode": "live", ',
      "utf8",
    )

    await expect(
      loadEvalTasks({
        tasksRoot,
      }),
    ).resolves.toMatchObject([
      {
        id: "regression/read-only",
        providerMode: "scripted",
      },
    ])
  })

  test("rejects task ids that would escape the artifact output root", async () => {
    const tasksRoot = await mkdtemp(join(tmpdir(), "eval-task-id-escape-"))
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-output-escape-"))
    tempDirectories.push(tasksRoot, outputRoot)
    await mkdir(join(tasksRoot, "regression"), { recursive: true })
    await writeFile(
      join(tasksRoot, "regression", "escape.json"),
      JSON.stringify({
        id: "../escape-output",
        scenario: "read-only",
        prompt: "escape output",
        workspaceFixture: "workspaces/basic",
      }),
      "utf8",
    )

    await expect(
      runDiscoveredEvalTasks({
        tasksRoot,
        outputRoot,
      }),
    ).rejects.toThrow("unsafe path segment")
  })
})
