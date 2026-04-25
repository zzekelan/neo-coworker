import { describe, expect, test } from "bun:test"
import {
  createAgentTool,
  createSubAgentRun,
  getBuiltinAgent,
  type AgentProfileService,
  type CreateSubAgentRunInput,
} from "../../src/agent"
import {
  composeAgentAwarePrompt,
  type DynamicPromptContext,
} from "../../src/orchestration/application/prompt-composer"

const promptContext: DynamicPromptContext = {
  activeSkillNames: [],
  environment: {
    workingDirectory: "/workspace/project",
    isGitRepository: true,
    platform: "linux",
    shell: "bash",
    date: "2026-04-25",
  },
}

const requiredSourceNoteFields = [
  "proposed type",
  "title",
  "URL/URI/path",
  "retrieved-at",
  "publisher/author",
  "reliability",
  "relevance",
  "supports",
  "contradicts",
  "key excerpts",
  "caveats",
  "suggested tags",
]

function createAgentProfileServiceStub(): AgentProfileService {
  return {
    async loadProfiles() {
      return []
    },
    async getProfile() {
      return undefined
    },
    async listProfiles() {
      return []
    },
    async getResolvedProfile() {
      return undefined
    },
    async listPrimaryAgents() {
      return []
    },
    reload() {},
  } as AgentProfileService
}

function createSubAgentInput(
  overrides: Partial<CreateSubAgentRunInput> = {},
): CreateSubAgentRunInput {
  const sessions = new Map([
    [
      "session-parent",
      {
        id: "session-parent",
        workspaceRoot: "/workspace/project",
        activeSkills: ["research/deep-research"],
      },
    ],
  ])
  const transcripts = new Map<string, ReturnType<CreateSubAgentRunInput["session"]["listTranscript"]>>()
  const runs = new Map<string, ReturnType<CreateSubAgentRunInput["session"]["getRun"]>>()

  const session: CreateSubAgentRunInput["session"] = {
    storageIdentity: "deep-research-subagents-test",
    getSession(sessionId) {
      return sessions.get(sessionId) ?? { id: sessionId, workspaceRoot: "/workspace/project", activeSkills: [] }
    },
    getRun(runId) {
      return (
        runs.get(runId) ?? {
          id: runId,
          sessionId: "sub-session",
          createdAt: 0,
          status: "queued",
          activeSkills: [],
          inputTokens: 0,
          outputTokens: 0,
          tokenUsageSource: null,
        }
      )
    },
    listTranscript(sessionId) {
      return transcripts.get(sessionId) ?? []
    },
    createRun(run) {
      const record = {
        id: run.id,
        sessionId: run.sessionId,
        createdAt: run.createdAt,
        status: run.status,
        activeSkills: [...(run.activeSkills ?? [])],
        inputTokens: run.inputTokens ?? 0,
        outputTokens: run.outputTokens ?? 0,
        tokenUsageSource: run.tokenUsageSource ?? null,
      }
      runs.set(run.id, record)
      return record
    },
    createAssistantMessage() {
      return { id: "assistant-message" }
    },
    createSyntheticMessage() {
      return { id: "synthetic-message" }
    },
    createMessagePart(part) {
      return { id: "part", kind: part.kind, text: part.text ?? null, data: part.data }
    },
    updateMessagePart(update) {
      return { id: update.partId, kind: "text", text: update.text ?? null, data: update.data }
    },
    recordRunTokenUsage(update) {
      return {
        ...this.getRun(update.runId),
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
        tokenUsageSource: update.tokenUsageSource,
      }
    },
    transitionRunToRunning(runId) {
      return { ...this.getRun(runId), status: "running" }
    },
    completeRun(runId) {
      return { ...this.getRun(runId), status: "completed" }
    },
    failRun(input) {
      return { ...this.getRun(input.runId), status: "failed" }
    },
    cancelRun(runId) {
      return { ...this.getRun(runId), status: "cancelled" }
    },
  }

  return {
    profile: getBuiltinAgent("source-researcher")!,
    prompt: "Collect source notes for the authentication docs.",
    sessionId: "session-parent",
    parentRunId: "parent-run",
    workspaceRoot: "/workspace/project",
    parentTools: {
      list() {
        return []
      },
      async execute() {
        throw new Error("parent tools should not execute")
      },
      async executeBatch() {
        return []
      },
    },
    model: {
      async *streamTurn() {
        throw new Error("model should not stream")
      },
    },
    session,
    skill: {
      async listCatalog() {
        return []
      },
      async loadSkill(input) {
        return {
          name: input.name,
          description: `Skill ${input.name}`,
          path: `builtin:${input.name}/SKILL.md`,
          instructions: `Instructions for ${input.name}`,
        }
      },
    },
    contextWindow: {
      getContextWindow() {
        return 16000
      },
    },
    createQueuedRun({ subRunId, prompt, activeSkills, createdAt }) {
      const subSessionId = "sub-session"
      sessions.set(subSessionId, { id: subSessionId, workspaceRoot: "/workspace/project", activeSkills })
      session.createRun({
        id: subRunId,
        sessionId: subSessionId,
        trigger: "summarize",
        status: "queued",
        createdAt,
        activeSkills,
      })
      transcripts.set(subSessionId, [
        {
          runId: subRunId,
          role: "user",
          sequence: 0,
          parts: [{ kind: "text", text: prompt }],
        },
      ])
      return { subSessionId }
    },
    buildAgentAwarePrompt(profile) {
      return composeAgentAwarePrompt(promptContext, profile)
    },
    createStepService({ session }) {
      return {
        isAbortError() {
          return false
        },
        isDetachedError() {
          return false
        },
        initializeRun() {},
        completeRun() {},
        failRun() {},
        cancelRun() {
          return false
        },
        async executeStep(stepInput) {
          const message = session.createAssistantMessage({
            sessionId: stepInput.sessionId,
            runId: stepInput.runId,
            sequence: 1,
            createdAt: 2,
          })
          session.createMessagePart({
            sessionId: stepInput.sessionId,
            runId: stepInput.runId,
            messageId: message.id,
            kind: "text",
            sequence: 0,
            text: "structured source notes",
            createdAt: 2,
          })
          return { status: "complete" }
        },
      }
    },
    createToolBatchExecutor() {
      return {
        async execute() {
          return []
        },
      }
    },
    createToolRuntime({ tools }) {
      return {
        list() {
          return tools
        },
        async execute() {
          return { output: "" }
        },
      }
    },
    createToolProvider({ runtime }) {
      return {
        list() {
          return runtime.list()
        },
        execute(input) {
          return runtime.execute(input)
        },
      }
    },
    ...overrides,
  }
}

describe("Deep Research source researcher subagents", () => {
  test("primary prompt describes adaptive 0-5 source collection fanout", () => {
    const prompt = composeAgentAwarePrompt(promptContext, getBuiltinAgent("deep-research"))

    expect(prompt).toContain("adaptive 0-5 Source Researcher subagents")
    expect(prompt).toContain("research breadth and uncertainty")
    expect(prompt).toContain("agent")
    expect(prompt).toContain("source-researcher")
  })

  test("registers a source researcher builtin subagent with the source-note skill contract", () => {
    const agent = getBuiltinAgent("source-researcher")

    expect(agent).toMatchObject({
      name: "source-researcher",
      displayName: "Source Researcher",
      description: "Source note collector",
      skills: ["source-note"],
      parallel: true,
    })
    expect(agent?.tools).not.toContain("write")
    expect(agent?.tools).not.toContain("edit")
    expect(agent?.tools).not.toContain("shell")

    const prompt = composeAgentAwarePrompt(promptContext, agent)
    expect(prompt).toContain("return structured source notes")
    expect(prompt).toContain("do not write `.ncoworker/research/**`")
    for (const field of requiredSourceNoteFields) {
      expect(prompt).toContain(field)
    }
  })

  test("can dispatch source researcher through the existing agent tool mechanics", async () => {
    const delegatedProfiles: string[] = []
    const tool = createAgentTool({
      sessionId: "session-parent",
      runId: "parent-run",
      agentProfileService: createAgentProfileServiceStub(),
      currentDepth: 0,
      async createSubAgentRun(profile, prompt) {
        delegatedProfiles.push(`${profile.name}:${profile.skills?.join(",")}:${prompt}`)
        return "source notes returned"
      },
    })

    const result = await tool.execute({
      args: {
        agent: "source-researcher",
        prompt: "Collect source notes for docs and weak claims.",
      },
    })

    expect(result).toEqual({ output: "source notes returned" })
    expect(delegatedProfiles).toEqual([
      "source-researcher:source-note:Collect source notes for docs and weak claims.",
    ])
  })

  test("source researcher subagent activates source-note instead of inheriting primary skills", async () => {
    const loadedSkills: string[] = []
    const queuedActiveSkills: string[][] = []
    let builtPrompt = ""

    await createSubAgentRun(
      createSubAgentInput({
        skill: {
          async listCatalog() {
            return []
          },
          async loadSkill(input) {
            loadedSkills.push(input.name)
            return {
              name: input.name,
              description: `Skill ${input.name}`,
              path: `builtin:${input.name}/SKILL.md`,
              instructions: `Instructions for ${input.name}`,
            }
          },
        },
        createQueuedRun(input) {
          queuedActiveSkills.push([...input.activeSkills])
          return { subSessionId: "sub-session-skill-contract" }
        },
        buildAgentAwarePrompt(profile) {
          builtPrompt = composeAgentAwarePrompt(promptContext, profile)
          return builtPrompt
        },
      }),
    )

    expect(queuedActiveSkills).toEqual([["source-note"]])
    expect(loadedSkills).toEqual(["source-note"])
    expect(loadedSkills).not.toContain("research/source-note")
    expect(builtPrompt).toContain("# Source Note Subagent Contract")
    expect(builtPrompt).toContain("active `source-note` skill")
    expect(builtPrompt).not.toContain("research/source-note")
  })

  test("source researcher startup emits structured secret-free skill load failure when source-note is missing", async () => {
    const events: Array<{ event: Record<string, unknown>; sessionId: string; runId: string }> = []
    const secretValue = "sk-test-source-note-secret"

    await expect(
      createSubAgentRun(
        createSubAgentInput({
          skill: {
            async listCatalog() {
              return []
            },
            async loadSkill(input) {
              throw new Error(`Required builtin skill missing: ${input.name}; OPENAI_API_KEY=${secretValue}`)
            },
          },
          runtimeObserver: {
            recordRuntimeEvent(input) {
              events.push({
                event: input.event,
                sessionId: input.sessionId,
                runId: input.runId,
              })
            },
          },
        }),
      ),
    ).rejects.toThrow("Required builtin skill missing: source-note")

    expect(events).toContainEqual(
      expect.objectContaining({
        sessionId: "session-parent",
        runId: expect.stringMatching(/^run_/),
        event: expect.objectContaining({
          type: "skill.load.failed",
          status: "failed",
          skillName: "source-note",
          agentId: "source-researcher",
          displayName: "Source Researcher",
          parentRunId: "parent-run",
          subRunId: expect.stringMatching(/^run_/),
          errorCode: "SKILL_LOAD_FAILED",
          errorMessage: expect.stringContaining("Required builtin skill missing: source-note"),
          reason: "startup",
        }),
      }),
    )
    expect(JSON.stringify(events)).not.toContain(secretValue)
  })

  test("source researcher emits structured subagent lifecycle status events", async () => {
    const events: Array<{ event: Record<string, unknown>; sessionId: string; runId: string }> = []

    await createSubAgentRun(
      createSubAgentInput({
        runtimeObserver: {
          recordRuntimeEvent(input) {
            events.push({
              event: input.event,
              sessionId: input.sessionId,
              runId: input.runId,
            })
          },
        },
      }),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent.started",
            parentRunId: "parent-run",
            subRunId: expect.any(String),
            agentId: "source-researcher",
            displayName: "Source Researcher",
            status: "started",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent.completed",
            parentRunId: "parent-run",
            subRunId: expect.any(String),
            agentId: "source-researcher",
            displayName: "Source Researcher",
            status: "completed",
          }),
        }),
      ]),
    )
  })

  test("weak source contract quarantines low reliability as caveat/open-question candidate", () => {
    const prompt = composeAgentAwarePrompt(promptContext, getBuiltinAgent("source-researcher"))

    expect(prompt).toContain("low reliability")
    expect(prompt).toContain("caveat/open-question candidate")
    expect(prompt).toContain("not an accepted source")
  })
})
