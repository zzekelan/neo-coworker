import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runEvalTask,
  type EvalProviderFactory,
} from "../../evals"
import {
  createOrchestrationActiveRunRegistry,
  createSessionRepository,
  openSessionDatabase,
} from "../../src/bootstrap"
import {
  createModelProvider,
  createModelRuntimeApi,
  type ModelObserverPort,
  type ProviderEvent,
  type ProviderTurnRequest,
} from "../../src/model"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("eval runner", () => {
  test("runs the real runtime path and grades exported trace artifacts", async () => {
    const result = await runEvalTask({
      task: {
        id: "read-summary",
        prompt: "Read README.md and summarize it",
        workspaceRoot: "test/fixtures/workspaces/read-search",
        outcomeExpectation: {
          runStatus: "completed",
          watchedFiles: [],
        },
        protocolExpectation: {
          requiredRuntimeEventTypes: [
            "run.started",
            "tool.call.completed",
            "run.completed",
          ],
          forbiddenRuntimeEventTypes: ["permission.requested", "run.failed", "run.cancelled"],
        },
        toolPolicyExpectation: {
          requiredToolNames: ["read"],
          forbiddenToolNames: ["write", "edit", "shell"],
        },
        traceExpectation: {
          requiredEventTypes: [
            "run.started",
            "tool.call.completed",
            "run.completed",
          ],
        },
      },
      providerInfo: {
        mode: "scripted",
        kind: "scripted",
        model: null,
      },
      createProvider: createProviderFactory([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Fixture summary ready." }
        },
      ]),
    })

    expect(result.artifact.runStatus).toBe("completed")
    expect(result.artifact.provider).toEqual({
      mode: "scripted",
      kind: "scripted",
      model: null,
    })
    expect(result.artifact.outcome).toMatchObject({
      runStatus: "completed",
      errorText: null,
      watchedFiles: [],
    })
    expect(result.artifact.metrics).toMatchObject({
      modelTurnCount: 2,
      toolCallCount: 1,
      permissionWaitCount: 0,
      retryCount: 0,
      terminalEventType: "run.completed",
    })
    expect(result.artifact.trace?.events.map((event) => event.eventType)).toContain(
      "model.turn.requested",
    )
    expect(result.artifact.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          producedByRunId: result.artifact.runId,
          timelineSequence: 0,
          parts: expect.arrayContaining([
            expect.objectContaining({
              kind: "text",
              producedByRunId: result.artifact.runId,
            }),
          ]),
        }),
        expect.objectContaining({
          role: "assistant",
          producedByRunId: result.artifact.runId,
          timelineSequence: 1,
        }),
      ]),
    )
    expect(Object.keys(result.artifact).sort()).toEqual([
      "metrics",
      "outcome",
      "provider",
      "runId",
      "runStatus",
      "runs",
      "runtimeEvents",
      "sessionId",
      "taskId",
      "timeline",
      "trace",
      "workspaceRoot",
    ])
    expect(
      result.artifact.timeline.some((entry) => readRecordField(entry, "eventType") !== undefined),
    ).toBe(false)
    expect(result.artifact.trace?.events.some((event) => "timelineSequence" in event)).toBe(false)
    expect(result.pass).toBe(true)
    expect(result.pass).toBe(true)
    expect(result.grades.trace).toEqual({
      pass: true,
      requiredEventTypes: [
        "run.started",
        "tool.call.completed",
        "run.completed",
      ],
      observedEventTypes: expect.arrayContaining([
        "run.started",
        "tool.call.completed",
        "run.completed",
      ]),
      missingEventTypes: [],
    })
    expect(result.grades.outcome.pass).toBe(true)
    expect(result.grades.protocol.pass).toBe(true)
    expect(result.grades.toolPolicy.pass).toBe(true)
    expect(result.grades.timeline.pass).toBe(true)
    expect(result.grades.traceSequence.pass).toBe(true)
    expect(result.grades.toolConsumption.pass).toBe(true)
    expect(result.grades.skillDisclosure.pass).toBe(true)
    expect(result.grades.promptAssembly.pass).toBe(true)
  })

  test("grades timeline ordering, trace sequence, and tool result consumption", async () => {
    const result = await runEvalTask({
      task: {
        id: "read-consumption",
        prompt: "Read README.md and summarize the heading",
        workspaceRoot: "test/fixtures/workspaces/read-search",
        timelineExpectation: {
          orderedTextIncludes: ["Read README heading.", "The heading is # demo workspace."],
          checkpoints: [
            {
              messageIndex: 1,
              role: "assistant",
              partKinds: ["text", "tool_call", "tool_result"],
              textIncludes: ["Read README heading.", "# demo workspace"],
              toolNames: ["read"],
            },
            {
              messageIndex: 2,
              role: "assistant",
              textIncludes: ["The heading is # demo workspace."],
            },
          ],
        },
        traceSequenceExpectation: {
          orderedEventTypes: [
            "run.started",
            "tool.call.completed",
            "model.prompt.assembled",
            "run.completed",
          ],
        },
        toolConsumptionExpectation: {
          requiredConsumptions: [
            {
              toolName: "read",
              toolResultIncludes: ["# demo workspace"],
              assistantTextIncludes: ["# demo workspace"],
            },
          ],
        },
      },
      providerInfo: {
        mode: "scripted",
        kind: "scripted",
        model: null,
      },
      createProvider: createProviderFactory([
        async function* () {
          yield { type: "text.delta", text: "Read README heading.\n" }
          yield {
            type: "tool.call",
            callId: "call_read_heading",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "The heading is # demo workspace." }
        },
      ]),
    })

    console.log(JSON.stringify({ pass: result.pass, grades: result.grades }, null, 2))

    expect(result.pass).toBe(true)
    expect(result.grades.timeline).toEqual({
      pass: true,
      orderedTextIncludes: ["Read README heading.", "The heading is # demo workspace."],
      observedTexts: expect.arrayContaining([
        "Read README heading.\n",
        "L1#f1469abc|# demo workspace\nL2#e3b0c442|\nL3#d806ab8e|This fixture exists for the read-only tool tests.",
        "The heading is # demo workspace.",
      ]),
      missingOrderedTexts: [],
      checkpointFailures: [],
    })
    expect(result.grades.traceSequence).toEqual({
      pass: true,
      orderedEventTypes: [
        "run.started",
        "tool.call.completed",
        "model.prompt.assembled",
        "run.completed",
      ],
      observedEventTypes: expect.arrayContaining([
        "run.started",
        "tool.call.completed",
        "model.prompt.assembled",
        "run.completed",
      ]),
      missingOrderedEventTypes: [],
    })
    expect(result.grades.toolConsumption).toEqual({
      pass: true,
      failures: [],
    })
  })

  test("seeds session skills and grades progressive disclosure across prompt assembly", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eval-runner-skill-"))
    tempDirectories.push(workspaceRoot)
    const reviewerRoot = join(workspaceRoot, ".ncoworker", "skills", "reviewer")
    const writerRoot = join(workspaceRoot, ".ncoworker", "skills", "writer")
    await mkdir(reviewerRoot, { recursive: true })
    await mkdir(writerRoot, { recursive: true })
    await Bun.write(
      join(reviewerRoot, "SKILL.md"),
      [
        "name: reviewer",
        "description: Review diffs carefully",
        "",
        "Always review for bugs first.",
      ].join("\n"),
    )
    await Bun.write(
      join(writerRoot, "SKILL.md"),
      [
        "name: writer",
        "description: Draft concise summaries",
        "",
        "Write concise operator-facing summaries.",
      ].join("\n"),
    )

    const result = await runEvalTask({
      task: {
        id: "skill-disclosure",
        prompt: "Use the writer skill after checking the reviewer default.",
        workspaceRoot,
        copyWorkspace: false,
        sessionSeed: {
          activeSkills: ["reviewer"],
        },
        timelineExpectation: {
          checkpoints: [
            {
              messageIndex: 1,
              role: "assistant",
              partKinds: ["tool_call", "tool_result"],
              toolNames: ["skill"],
            },
            {
              messageIndex: 2,
              role: "assistant",
              textIncludes: ["Writer skill activated."],
            },
          ],
        },
        traceSequenceExpectation: {
          orderedEventTypes: [
            "skill.run.snapshot.applied",
            "model.prompt.assembled",
            "skill.activated",
            "model.prompt.assembled",
            "run.completed",
          ],
        },
        skillDisclosureExpectation: {
          skillName: "writer",
        },
        promptAssemblyExpectation: {
          checkpoints: [
            {
              promptIndex: 0,
              catalogSkillNamesIncludes: ["reviewer", "writer"],
              activeSkillNamesIncludes: ["reviewer"],
              activeSkillNamesExcludes: ["writer"],
              activeSkillCount: 1,
            },
            {
              promptIndex: 1,
              catalogSkillNamesExcludes: ["reviewer", "writer"],
              activeSkillNamesIncludes: ["writer"],
              activeSkillNamesExcludes: ["reviewer"],
              activeSkillCount: 1,
            },
          ],
          requireStableSystemPromptHash: true,
          requireDistinctSystemReminderHashes: true,
        },
      },
      providerInfo: {
        mode: "scripted",
        kind: "scripted",
        model: null,
      },
      createProvider: createProviderFactory([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_skill_writer",
            name: "skill",
            inputText: '{"name":"writer"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Writer skill activated." }
        },
      ]),
    })

    console.log(
      JSON.stringify(
        {
          pass: result.pass,
          timeline: result.grades.timeline,
          traceData: result.grades.traceData,
          runRecords: result.grades.runRecords,
          timelineCheckpoints: result.grades.timeline.checkpointFailures,
          traceDataFailures: result.grades.traceData.failures,
        },
        null,
        2,
      ),
    )

    expect(result.pass).toBe(true)
    expect(result.artifact.timeline).toHaveLength(3)
    expect(result.grades.skillDisclosure).toEqual({
      pass: true,
      failures: [],
    })
    expect(result.grades.promptAssembly).toEqual({
      pass: true,
      failures: [],
      observedPromptCount: 2,
    })
  })

  test("injects summarize failures so breaker-reset eval tasks can grade recovery", async () => {
    const result = await runEvalTask({
      task: {
        id: "context-compaction-breaker-reset",
        prompt: "Trip the auto-compaction breaker, recover with /compact, and prove auto compaction resumes.",
        workspaceRoot: "evals/fixtures/workspaces/skills",
        contextWindow: 14000,
        steps: [
          {
            kind: "prompt",
            prompt:
              "Use the read tool to read LONG_CONTEXT.md completely. Then answer exactly `Breaker prep ready`.",
          },
          {
            kind: "prompt",
            prompt: "Do not use any tools. Answer exactly `Breaker failure one`.",
          },
          {
            kind: "prompt",
            prompt: "Do not use any tools. Answer exactly `Breaker failure two`.",
          },
          {
            kind: "prompt",
            prompt: "Do not use any tools. Answer exactly `Breaker failure three`.",
          },
          {
            kind: "prompt",
            prompt: "Do not use any tools. Answer exactly `Breaker paused but replying`.",
          },
          {
            kind: "command",
            command: "compact",
          },
          {
            kind: "prompt",
            prompt:
              "Do not use any tools. The repeated filler block below exists only to force one more large prompt turn after the manual compact succeeds. Ignore the filler and answer exactly `Breaker reset auto compact`. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset. Breaker reset validation filler line to trigger automatic compaction after manual reset.",
          },
        ],
        providerFaults: {
          summarizeFailures: 3,
          summarizeFailureMessage: "Injected summarize failure",
        },
        runRecordsExpectation: {
          checkpoints: [
            {
              runIndex: 5,
              trigger: "command",
              status: "completed",
            },
            {
              runIndex: 6,
              trigger: "cli",
              status: "completed",
            },
          ],
        },
      },
      providerInfo: {
        mode: "scripted",
        kind: "scripted",
        model: null,
      },
      createProvider: createProviderFactory([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_read_long_context",
            name: "read",
            inputText: '{"path":"LONG_CONTEXT.md"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Breaker prep ready" }
        },
        async function* () {
          yield { type: "text.delta", text: "Breaker failure one" }
        },
        async function* () {
          yield { type: "text.delta", text: "Breaker failure two" }
        },
        async function* () {
          yield { type: "text.delta", text: "Breaker failure three" }
        },
        async function* () {
          yield { type: "text.delta", text: "Breaker paused but replying" }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: [
              "Primary Request",
              "Recover the compaction breaker through a manual compact.",
              "",
              "Files & Code",
              "LONG_CONTEXT.md",
              "",
              "Errors & Fixes",
              "Three automatic compactions failed before this manual run.",
              "",
              "Next Steps",
              "Allow automatic compaction again on the next prompt.",
            ].join("\n"),
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: [
              "Primary Request",
              "Resume automatic compaction after the manual reset.",
              "",
              "Files & Code",
              "LONG_CONTEXT.md",
              "",
              "Errors & Fixes",
              "The breaker was reset by a successful manual compact.",
              "",
              "Next Steps",
              "Answer the user.",
            ].join("\n"),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Breaker reset auto compact" }
        },
        ]),
      })

    expect(result.pass).toBe(true)
    expect(result.grades.timeline.pass).toBe(true)
    expect(result.grades.timeline.observedTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Automatic compaction failed: Injected summarize failure"),
        expect.stringContaining("Automatic compaction has been paused"),
        expect.stringContaining("Primary Request"),
        expect.stringContaining("Breaker reset auto compact"),
      ]),
    )
    expect(result.grades.traceData.pass).toBe(true)
    expect(result.grades.runRecords.pass).toBe(true)
  })

  test("cancels the active run when permission requests are not auto-replied", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eval-runner-permission-"))
    tempDirectories.push(workspaceRoot)
    await mkdir(join(workspaceRoot, "src"), { recursive: true })

    const activeRuns = createOrchestrationActiveRunRegistry()
    let started:
      | {
          storageIdentity: string
          sessionId: string
          runId: string
        }
      | undefined

    await expect(
      runEvalTask({
        task: {
          id: "permission-missing",
          prompt: "Run pwd",
          workspaceRoot,
          copyWorkspace: false,
        },
        providerInfo: {
          mode: "scripted",
          kind: "scripted",
          model: null,
        },
        createProvider: createProviderFactory([
          async function* () {
            yield {
              type: "tool.call",
              callId: "call_shell",
              name: "shell",
              inputText: '{"command":"pwd"}',
            }
          },
        ]),
        activeRuns,
        onRunStarted(input) {
          started = input
        },
      }),
    ).rejects.toThrow("without autoReplyPermission")

    expect(started).toBeDefined()
    expect(activeRuns.has(started!)).toBe(false)

    const database = openSessionDatabase(started!.storageIdentity)

    try {
      const repository = createSessionRepository({
        database,
        now: () => 100,
      })

      expect(repository.runs.get(started!.runId).status).toBe("cancelled")
    } finally {
      database.close(false)
    }
  })

  test("rejects watched files that escape the workspace root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-runner-watched-path-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(directory, "secret.txt"), "secret")

    await expect(
      runEvalTask({
        task: {
          id: "watched-path-escape",
          prompt: "Say hi",
          workspaceRoot,
          copyWorkspace: false,
          outcomeExpectation: {
            runStatus: "completed",
            watchedFiles: [
              {
                path: "../secret.txt",
                shouldExist: true,
              },
            ],
          },
        },
        providerInfo: {
          mode: "scripted",
          kind: "scripted",
          model: null,
        },
        createProvider: createProviderFactory([
          async function* () {
            yield { type: "text.delta", text: "done" }
          },
        ]),
      }),
    ).rejects.toThrow("must stay inside workspace")
  })

  test("rejects watched files that escape through a symlinked parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-runner-watched-symlink-"))
    tempDirectories.push(directory)
    const workspaceRoot = join(directory, "workspace")
    const outsideRoot = join(directory, "outside")
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await Bun.write(join(outsideRoot, "secret.txt"), "secret")
    await symlink(outsideRoot, join(workspaceRoot, "escape"))

    await expect(
      runEvalTask({
        task: {
          id: "watched-symlink-escape",
          prompt: "Say hi",
          workspaceRoot,
          copyWorkspace: false,
          outcomeExpectation: {
            runStatus: "completed",
            watchedFiles: [
              {
                path: "escape/secret.txt",
                shouldExist: true,
              },
            ],
          },
        },
        providerInfo: {
          mode: "scripted",
          kind: "scripted",
          model: null,
        },
        createProvider: createProviderFactory([
          async function* () {
            yield { type: "text.delta", text: "done" }
          },
        ]),
      }),
    ).rejects.toThrow("must stay inside workspace")
  })
})

function readRecordField(value: unknown, field: string) {
  if (typeof value !== "object" || value === null) {
    return undefined
  }

  return (value as Record<string, unknown>)[field]
}

function createProviderFactory(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
): EvalProviderFactory {
  return (input: { modelObserver?: ModelObserverPort }) => {
    let index = 0

    return createModelProvider({
      observer: input.modelObserver,
      runtime: createModelRuntimeApi({
        async *streamTurn(request: ProviderTurnRequest) {
          const turn = turns[index] ?? turns.at(-1)
          index += 1

          if (!turn) {
            throw new Error(`Unexpected provider turn ${index}`)
          }

          for await (const event of turn(request)) {
            yield event
          }
        },
      }),
    })
  }
}
