import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type OpenAI from "openai"
import { getDefaultEvalOutputRoot, loadEvalTasks, runDiscoveredEvalTasks } from "../../evals"
import { createModelProvider, createModelRuntimeApi } from "../../src/model"

const tempDirectories: string[] = []
const activeServers: Array<{ stop(force?: boolean): void }> = []

afterEach(async () => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop(true)
  }

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
      "regression/datetime",
      "regression/ncoworker-path-safety",
      "regression/permission-allow-write",
      "regression/permission-deny-write",
      "regression/read-only",
      "regression/retry-recovery",
      "regression/sub-agent-explore",
      "regression/sub-agent-parallel-safety",
    ])

    const suite = await runDiscoveredEvalTasks({
      outputRoot,
    })

    expect(suite.pass).toBe(true)
    expect(suite.providerMode).toBe("scripted")
    expect(suite.results).toHaveLength(9)

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

  test("defaults eval artifacts to .ncoworker/evals with legacy fallback", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eval-output-root-"))
    tempDirectories.push(workspaceRoot)

    expect(getDefaultEvalOutputRoot(workspaceRoot)).toBe(
      join(workspaceRoot, ".ncoworker", "evals"),
    )

    await mkdir(join(workspaceRoot, ".agents", "evals"), { recursive: true })

    expect(getDefaultEvalOutputRoot(workspaceRoot)).toBe(
      join(workspaceRoot, ".agents", "evals"),
    )

    await mkdir(join(workspaceRoot, ".ncoworker", "evals"), { recursive: true })

    expect(getDefaultEvalOutputRoot(workspaceRoot)).toBe(
      join(workspaceRoot, ".ncoworker", "evals"),
    )
  })

  test("loads and runs the live eval catalog through the default provider assembly path", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-live-direct-"))
    tempDirectories.push(outputRoot)
    const openAIConfigs: unknown[] = []

    const tasks = await loadEvalTasks({
      providerMode: "live",
    })
    expect(tasks.map((task) => task.id)).toEqual([
      "live/context-compaction-auto",
      "live/context-compaction-breaker-reset",
      "live/context-compaction-manual",
      "live/context-compaction-recovery",
      "live/datetime",
      "live/read-only",
      "live/skill-activation-persistence",
      "live/skill-explicit-activation",
      "live/skill-injection-first-turn",
      "live/skill-model-auto-selection",
      "live/skill-run-override",
      "live/skill-run-snapshot",
      "live/token-tracking",
      "live/tool-codesearch",
      "live/tool-glob",
      "live/tool-grep",
      "live/tool-webfetch",
      "live/tool-websearch",
    ])

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

  test("supports multi-step live eval tasks that mix prompt and command runs", async () => {
    const tasksRoot = await mkdtemp(join(tmpdir(), "eval-live-steps-task-"))
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-live-steps-output-"))
    tempDirectories.push(tasksRoot, outputRoot)
    await mkdir(join(tasksRoot, "live"), { recursive: true })
    await writeFile(
      join(tasksRoot, "live", "context-compaction-manual.json"),
      JSON.stringify({
        id: "live/context-compaction-manual",
        providerMode: "live",
        prompt: "Read LONG_CONTEXT.md, compact manually, and prove the next prompt keeps the session context.",
        workspaceFixture: "workspaces/skills",
        steps: [
          {
            kind: "prompt",
            prompt:
              "Use the read tool to read LONG_CONTEXT.md completely. Then answer exactly `Prepared manual compaction`.",
          },
          {
            kind: "command",
            command: "compact",
          },
          {
            kind: "prompt",
            prompt:
              "Do not use any tools. Answer exactly `Manual compact recovered LONG_CONTEXT.md`.",
          },
        ],
        outcomeExpectation: {
          runStatus: "completed",
        },
        transcriptExpectation: {
          checkpoints: [
            {
              messageIndex: 3,
              role: "synthetic",
              partKinds: ["compaction_boundary", "text"],
            },
          ],
        },
        traceDataExpectation: {
          events: [
            {
              runIndex: 1,
              eventType: "compaction.completed",
              fields: [{ field: "trigger", equalsString: "manual" }],
            },
          ],
        },
        runRecordsExpectation: {
          checkpoints: [
            {
              runIndex: 1,
              trigger: "command",
              status: "completed",
            },
            {
              runIndex: 2,
              trigger: "cli",
              status: "completed",
            },
          ],
        },
      }),
      "utf8",
    )

    const suite = await runDiscoveredEvalTasks({
      providerMode: "live",
      taskIds: ["live/context-compaction-manual"],
      tasksRoot,
      outputRoot,
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
      },
      createClient() {
        return {} as OpenAI
      },
      createOpenAIProviderImpl(input) {
        let turn = 0

        return createModelProvider({
          observer: input.observer,
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              turn += 1

              if (turn === 1) {
                yield {
                  type: "tool.call",
                  callId: "call_read_long_context",
                  name: "read",
                  inputText: '{"path":"LONG_CONTEXT.md"}',
                }
                return
              }

              if (turn === 2) {
                yield { type: "text.delta", text: "Prepared manual compaction" }
                return
              }

              if (turn === 3) {
                yield {
                  type: "text.delta",
                  text: [
                    "Primary Request",
                    "Manually compact the session and keep the key file context available.",
                    "",
                    "Key Concepts",
                    "Manual compaction should preserve the important working state.",
                    "",
                    "Files & Code",
                    "LONG_CONTEXT.md",
                    "",
                    "Errors & Fixes",
                    "None.",
                    "",
                    "Problem Solving",
                    "Compact now and resume on the next prompt.",
                    "",
                    "User Messages",
                    "Manual compact follow-up",
                    "",
                    "Pending Tasks",
                    "Answer the next prompt.",
                    "",
                    "Current Work",
                    "Compacting before the next prompt.",
                    "",
                    "Next Steps",
                    "Resume with the compacted session.",
                  ].join("\n"),
                }
                return
              }

              if (turn === 4) {
                yield { type: "text.delta", text: "Manual compact recovered LONG_CONTEXT.md" }
                return
              }

              throw new Error(`Unexpected provider turn ${turn}`)
            },
          }),
        })
      },
    })

    expect(suite.pass).toBe(true)
    expect(suite.results[0]?.result.artifact.runs).toHaveLength(3)
    expect(suite.results[0]?.result.artifact.runs[1]).toMatchObject({
      trigger: "command",
      status: "completed",
    })

    const runsArtifact = await Bun.file(
      join(suite.results[0]!.artifactDir, "runs.json"),
    ).json()
    expect(runsArtifact).toEqual([
      expect.objectContaining({
        trigger: "cli",
      }),
      expect.objectContaining({
        trigger: "command",
      }),
      expect.objectContaining({
        trigger: "cli",
      }),
    ])
  })

  test("wires SEARCH_BACKEND_URL into live eval runs for websearch tasks", async () => {
    const tasksRoot = await mkdtemp(join(tmpdir(), "eval-live-search-task-"))
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-live-search-output-"))
    tempDirectories.push(tasksRoot, outputRoot)
    await mkdir(join(tasksRoot, "live"), { recursive: true })
    await writeFile(
      join(tasksRoot, "live", "tool-websearch.json"),
      JSON.stringify({
        id: "live/tool-websearch",
        providerMode: "live",
        prompt: "Use websearch and repeat BACKEND_RESULT_TOKEN.",
        workspaceFixture: "workspaces/basic",
        permissionPolicy: {
          websearch: "allow",
        },
        outcomeExpectation: {
          runStatus: "completed",
        },
        toolPolicyExpectation: {
          requiredToolNames: ["websearch"],
        },
        toolConsumptionExpectation: {
          requiredConsumptions: [
            {
              toolName: "websearch",
              toolResultIncludes: ["BACKEND_RESULT_TOKEN"],
              assistantTextIncludes: ["BACKEND_RESULT_TOKEN"],
            },
          ],
        },
      }),
      "utf8",
    )

    const searchRequests: Array<{ authorization: string | null; body: string }> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return request.text().then((body) => {
          searchRequests.push({
            authorization: request.headers.get("authorization"),
            body,
          })

          return Response.json({
            output: "BACKEND_RESULT_TOKEN from eval search backend",
          })
        })
      },
    })
    activeServers.push(server)

    const suite = await runDiscoveredEvalTasks({
      providerMode: "live",
      taskIds: ["live/tool-websearch"],
      tasksRoot,
      outputRoot,
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
        SEARCH_BACKEND_URL: server.url.toString(),
        SEARCH_BACKEND_BEARER_TOKEN: "search-token",
      },
      createClient() {
        return {} as OpenAI
      },
      createOpenAIProviderImpl(input) {
        let turn = 0

        return createModelProvider({
          observer: input.observer,
          runtime: createModelRuntimeApi({
            async *streamTurn() {
              turn += 1

              if (turn === 1) {
                yield {
                  type: "tool.call",
                  callId: "call_websearch",
                  name: "websearch",
                  inputText: '{"query":"BACKEND_RESULT_TOKEN"}',
                }
                return
              }

              if (turn === 2) {
                yield { type: "text.delta", text: "BACKEND_RESULT_TOKEN confirmed." }
                return
              }

              throw new Error(`Unexpected provider turn ${turn}`)
            },
          }),
        })
      },
    })

    expect(suite.pass).toBe(true)
    expect(searchRequests).toEqual([
      {
        authorization: "Bearer search-token",
        body: JSON.stringify({
          toolName: "websearch",
          query: "BACKEND_RESULT_TOKEN",
        }),
      },
    ])
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
