import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionRunService } from "../../src/session"
import {
  createPermissionRepository,
  type PermissionRepository,
} from "../../src/permission"
import {
  buildCreateSubSessionInput,
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
  type SessionRepository as StorageRepository,
} from "../../src/session"
import {
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
  createModelRuntimeApi,
} from "../../src/model"
import {
  TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY,
  TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY,
} from "../../src/orchestration"
import { estimateModelTurnUsage } from "../../src/model/application/token-usage"
import { createRuntime } from "../../src/bootstrap"
import { createSkillRuntimeApi, type SkillStore } from "../../src/skill"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const README_READ_OUTPUT = [
  "L1#f1469abc|# demo workspace",
  "L2#e3b0c442|",
  "L3#d806ab8e|This fixture exists for the read-only tool tests.",
].join("\n")

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("subsession transcript isolation", () => {
  test("keeps subagent runtime messages isolated from the parent transcript", async () => {
    const harness = await createHarness("subsession-isolation-runtime", true)
    const subagentInternalMarker = "SUBAGENT_TOKEN_BLOB ".repeat(600)
    const subagentInternalNote = `Subagent internal note. ${subagentInternalMarker}`
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_parent",
      messageId: "message_parent_user",
      prompt: "Delegate README inspection through the agent tool",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_agent",
            name: "agent",
            inputText:
              '{"agent":"explore","prompt":"Inspect README.md and return only the final delegated summary."}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(
          "Inspect README.md and return only the final delegated summary.",
        )
        expect(requestText).not.toContain("Delegate README inspection through the agent tool")

        yield { type: "text.delta", text: subagentInternalNote }
        yield {
          type: "tool.call",
          callId: "call_sub_read",
            name: "read",
            inputText: '{"path":"README.md"}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(
          "Inspect README.md and return only the final delegated summary.",
        )
        expect(requestText).toContain(subagentInternalMarker)
        expect(requestText).toContain("This fixture exists for the read-only tool tests.")
        expect(requestText).not.toContain("Delegate README inspection through the agent tool")

          yield { type: "text.delta", text: "Delegated summary for parent." }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Delegate README inspection through the agent tool")
          expect(requestText).toContain("Delegated summary for parent.")
          expect(requestText).not.toContain(subagentInternalMarker)
          expect(requestText).not.toContain("This fixture exists for the read-only tool tests.")

          yield { type: "text.delta", text: "Parent finished after delegated work." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const topLevelSessions = harness.repository.sessions.listTopLevel()
    const subSessions = harness.repository.sessions.listSubSessions(harness.session.id)

    expect(requests).toHaveLength(4)
    expect(topLevelSessions).toEqual([
      expect.objectContaining({ id: harness.session.id, parentSessionId: undefined }),
    ])
    expect(subSessions).toEqual([
      expect.objectContaining({ parentSessionId: harness.session.id }),
    ])

    const subSession = subSessions[0]!
    const subRuns = harness.repository.runs.listBySession(subSession.id)
    expect(subRuns).toHaveLength(1)

    const subRun = subRuns[0]!
    const parentTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const subTranscript = harness.repository.messages.listSessionTranscript(subSession.id)
    const parentText = readTranscriptText(parentTranscript).join("\n")
    const subText = readTranscriptText(subTranscript).join("\n")
    const parentRun = harness.repository.runs.get(started.run.id)
    const initialParentRequest = requests[0]!
    const parentFollowupRequest = requests[3]!
    const subagentFollowupRequest = requests[2]!
    const initialParentRequestInputTokens = estimateProviderTurnInputTokens(initialParentRequest)
    const parentRequestInputTokens = estimateProviderTurnInputTokens(parentFollowupRequest)
    const leakedParentRequestInputTokens = estimateProviderTurnInputTokens({
      ...parentFollowupRequest,
      messages: [...parentFollowupRequest.messages, ...subagentFollowupRequest.messages],
    })
    const expectedParentAggregateInputTokens =
      initialParentRequestInputTokens + parentRequestInputTokens
    const leakedParentAggregateInputTokens =
      initialParentRequestInputTokens + leakedParentRequestInputTokens

    expect(parentTranscript).toHaveLength(3)
    expect([...new Set(parentTranscript.map((message) => message.runId))]).toEqual([started.run.id])
    expect(parentTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(parentTranscript[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(parentTranscript[1]?.parts[1]).toMatchObject({
      kind: "tool_result",
      text: "Delegated summary for parent.",
      data: {
        callId: "call_agent",
        toolName: "agent",
        output: "Delegated summary for parent.",
      },
    })
    expect(parentTranscript[2]?.parts).toMatchObject([
      { kind: "text", text: "Parent finished after delegated work." },
    ])
    expect(parentText).toContain("Delegate README inspection through the agent tool")
    expect(parentText).toContain("Delegated summary for parent.")
    expect(parentText).toContain("Parent finished after delegated work.")
    expect(parentText).not.toContain(
      "Inspect README.md and return only the final delegated summary.",
    )
    expect(parentText).not.toContain(subagentInternalMarker)
    expect(parentText).not.toContain("This fixture exists for the read-only tool tests.")

    expect(subRun.parentRunId).toBe(started.run.id)
    expect(subTranscript).toHaveLength(3)
    expect([...new Set(subTranscript.map((message) => message.runId))]).toEqual([subRun.id])
    expect(subTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(subTranscript[1]?.parts.map((part) => part.kind)).toEqual(["text", "tool_call", "tool_result"])
    expect(subTranscript[1]?.parts[0]?.kind).toBe("text")
    expect(subTranscript[1]?.parts[0]?.text).toContain("Subagent internal note.")
    expect(subTranscript[1]?.parts[0]?.text).toContain(subagentInternalMarker)
    expect(subTranscript[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: README_READ_OUTPUT,
      data: {
        callId: "call_sub_read",
        toolName: "read",
        output: README_READ_OUTPUT,
      },
    })
    expect(subTranscript[2]?.parts).toMatchObject([{ kind: "text", text: "Delegated summary for parent." }])
    expect(subText).toContain("Inspect README.md and return only the final delegated summary.")
    expect(subText).toContain(subagentInternalMarker)
    expect(subText).toContain("This fixture exists for the read-only tool tests.")
    expect(subText).toContain("Delegated summary for parent.")
    expect(subText).not.toContain("Delegate README inspection through the agent tool")
    expect(subText).not.toContain("Parent finished after delegated work.")

    expect(parentRun.tokenUsageSource).toBe("estimated")
    expect(parentRun.inputTokens).toBe(expectedParentAggregateInputTokens)
    expect(parentRun.inputTokens).toBeGreaterThan(0)
    expect(subRun.tokenUsageSource).toBe("estimated")
    expect(subRun.inputTokens).toBeGreaterThan(0)
    expect(leakedParentRequestInputTokens).toBeGreaterThan(parentRequestInputTokens)
    expect(leakedParentRequestInputTokens - parentRequestInputTokens).toBeGreaterThan(500)
    expect(leakedParentAggregateInputTokens).toBeGreaterThan(parentRun.inputTokens)
    expect(leakedParentAggregateInputTokens - parentRun.inputTokens).toBeGreaterThan(500)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.call.completed",
        callId: "call_agent",
        name: "agent",
        output: "Delegated summary for parent.",
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(parentRun.status).toBe("completed")
    expect(harness.repository.runs.get(subRun.id).status).toBe("completed")
  })

  test("keeps nested subagent runtime messages isolated across parent, child, and grandchild sessions", async () => {
    const harness = await createHarness("subsession-isolation-runtime-nested", true)
    harness.repository.sessions.update({
      sessionId: harness.session.id,
      activeSkills: ["nested-agent"],
    })

    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_parent_nested",
      messageId: "message_parent_nested_user",
      prompt: "Delegate README inspection through nested agent work",
    })

    const requests: ProviderTurnRequest[] = []
    let nestedRunCounter = 0
    const provider = createTurnProvider(requests, [
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_parent_agent",
          name: "agent",
          inputText:
            '{"agent":"explore","prompt":"Inspect README.md through one deeper nested delegate and return only the delegated summary."}',
        }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(
          "Inspect README.md through one deeper nested delegate and return only the delegated summary.",
        )
        expect(requestText).not.toContain("Delegate README inspection through nested agent work")

        yield { type: "text.delta", text: "A internal note." }
        yield {
          type: "tool.call",
          callId: "call_nested_agent",
          name: "agent",
          inputText:
            '{"agent":"explore","prompt":"Read README.md and return only the nested delegated summary."}',
        }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(
          "Read README.md and return only the nested delegated summary.",
        )
        expect(requestText).not.toContain("Delegate README inspection through nested agent work")
        expect(requestText).not.toContain("A internal note.")

        yield { type: "text.delta", text: "B internal note." }
        yield {
          type: "tool.call",
          callId: "call_b_read",
          name: "read",
          inputText: '{"path":"README.md"}',
        }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(
          "Read README.md and return only the nested delegated summary.",
        )
        expect(requestText).toContain("B internal note.")
        expect(requestText).toContain("This fixture exists for the read-only tool tests.")
        expect(requestText).not.toContain("A internal note.")

        yield { type: "text.delta", text: "Nested summary from B." }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(
          "Inspect README.md through one deeper nested delegate and return only the delegated summary.",
        )
        expect(requestText).toContain("A internal note.")
        expect(requestText).toContain("Nested summary from B.")
        expect(requestText).not.toContain("B internal note.")
        expect(requestText).not.toContain("This fixture exists for the read-only tool tests.")

        yield { type: "text.delta", text: "Delegated summary from A." }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain("Delegate README inspection through nested agent work")
        expect(requestText).toContain("Delegated summary from A.")
        expect(requestText).not.toContain("A internal note.")
        expect(requestText).not.toContain("Nested summary from B.")
        expect(requestText).not.toContain("B internal note.")
        expect(requestText).not.toContain("This fixture exists for the read-only tool tests.")

        yield { type: "text.delta", text: "Parent finished after nested delegated work." }
      },
    ])

    const nestedSkill = {
      async listCatalog() {
        return [
          {
            name: "nested-agent",
            description: "Inject a test-only nested agent tool",
            path: "/skills/nested-agent",
          },
        ]
      },
      async loadSkill(input: { name: string }) {
        if (input.name !== "nested-agent") {
          throw new Error(`Unknown test skill: ${input.name}`)
        }

        return {
          name: "nested-agent",
          description: "Inject a test-only nested agent tool",
          path: "/skills/nested-agent",
          instructions: "Nested delegation is available for this runtime isolation test.",
          injectedTools: [
            {
              name: "agent",
              description: "Delegate a nested runtime subagent for tests",
              concurrency: "read-only" as const,
              async execute(toolInput: { args: unknown }) {
                const args = toolInput.args as {
                  agent?: unknown
                  prompt?: unknown
                }

                if (typeof args?.agent !== "string" || typeof args?.prompt !== "string") {
                  return {
                    output: "Malformed nested agent arguments.",
                    isError: true,
                  }
                }

                const childSessions = harness.repository.sessions.listSubSessions(harness.session.id)
                if (childSessions.length !== 1) {
                  throw new Error(`Expected exactly one child session before nesting, got ${childSessions.length}`)
                }

                const childSession = childSessions[0]!
                const childRuns = harness.repository.runs.listBySession(childSession.id)
                if (childRuns.length !== 1) {
                  throw new Error(`Expected exactly one child run before nesting, got ${childRuns.length}`)
                }

                nestedRunCounter += 1
                const nestedSession = buildCreateSubSessionInput({
                  parentSession: childSession,
                  prompt: args.prompt,
                  trigger: "prompt",
                })
                const created = harness.repository.createSubSessionWithRun({
                  session: nestedSession,
                  run: {
                    id: `run_nested_child_${nestedRunCounter}`,
                    trigger: "prompt",
                    createdAt: harness.now(),
                    activeSkills: nestedSession.activeSkills,
                    parentRunId: childRuns[0]!.id,
                  },
                  message: {
                    sequence: 0,
                    createdAt: harness.now(),
                  },
                  part: {
                    kind: "text",
                    sequence: 0,
                    text: args.prompt,
                    createdAt: harness.now(),
                  },
                })

                const nestedRuntime = createRuntime({
                  provider,
                  repository: harness.repository,
                  permissionRepository: harness.permissionRepository,
                  skill: nestedSkill,
                  now: harness.now,
                })
                const nestedHandle = await nestedRuntime.run({
                  sessionId: created.session.id,
                  runId: created.run.id,
                })
                await collectEvents(nestedHandle.events)

                return {
                  output:
                    readTranscriptText(
                      harness.repository.messages.listSessionTranscript(created.session.id),
                    ).at(-1) ?? "",
                }
              },
            },
          ],
        } as never
      },
    }

    const runtime = createRuntime({
      provider,
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      skill: nestedSkill,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    await collectEvents(handle.events)

    const topLevelSessions = harness.repository.sessions.listTopLevel()
    const childSessions = harness.repository.sessions.listSubSessions(harness.session.id)
    expect(topLevelSessions).toEqual([
      expect.objectContaining({ id: harness.session.id, parentSessionId: undefined }),
    ])
    expect(childSessions).toHaveLength(1)

    const childSession = childSessions[0]!
    const grandchildSessions = harness.repository.sessions.listSubSessions(childSession.id)
    expect(grandchildSessions).toHaveLength(1)

    const grandchildSession = grandchildSessions[0]!
    expect(grandchildSession.parentSessionId).toBe(childSession.id)

    const childRuns = harness.repository.runs.listBySession(childSession.id)
    const grandchildRuns = harness.repository.runs.listBySession(grandchildSession.id)
    expect(childRuns).toHaveLength(1)
    expect(grandchildRuns).toHaveLength(1)

    const childRun = childRuns[0]!
    const grandchildRun = grandchildRuns[0]!
    const parentTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const childTranscript = harness.repository.messages.listSessionTranscript(childSession.id)
    const grandchildTranscript = harness.repository.messages.listSessionTranscript(grandchildSession.id)
    const parentText = readTranscriptText(parentTranscript).join("\n")
    const childText = readTranscriptText(childTranscript).join("\n")
    const grandchildText = readTranscriptText(grandchildTranscript).join("\n")

    expect(parentTranscript).toHaveLength(3)
    expect(parentTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(parentTranscript[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "tool_result"])
    expect(parentTranscript[1]?.parts[1]).toMatchObject({
      kind: "tool_result",
      text: "Delegated summary from A.",
      data: {
        callId: "call_parent_agent",
        toolName: "agent",
        output: "Delegated summary from A.",
      },
    })
    expect(parentText).toContain("Delegate README inspection through nested agent work")
    expect(parentText).toContain("Delegated summary from A.")
    expect(parentText).toContain("Parent finished after nested delegated work.")
    expect(parentText).not.toContain(
      "Inspect README.md through one deeper nested delegate and return only the delegated summary.",
    )
    expect(parentText).not.toContain("A internal note.")
    expect(parentText).not.toContain("Read README.md and return only the nested delegated summary.")
    expect(parentText).not.toContain("Nested summary from B.")
    expect(parentText).not.toContain("B internal note.")
    expect(parentText).not.toContain("This fixture exists for the read-only tool tests.")

    expect(childRun.parentRunId).toBe(started.run.id)
    expect(childTranscript).toHaveLength(3)
    expect(childTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(childTranscript[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(childTranscript[1]?.parts[0]).toMatchObject({
      kind: "text",
      text: "A internal note.",
    })
    expect(childTranscript[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: "Nested summary from B.",
      data: {
        callId: "call_nested_agent",
        toolName: "agent",
        output: "Nested summary from B.",
      },
    })
    expect(childText).toContain(
      "Inspect README.md through one deeper nested delegate and return only the delegated summary.",
    )
    expect(childText).toContain("A internal note.")
    expect(childText).toContain("Nested summary from B.")
    expect(childText).toContain("Delegated summary from A.")
    expect(childText).not.toContain("Delegate README inspection through nested agent work")
    expect(childText).not.toContain("Read README.md and return only the nested delegated summary.")
    expect(childText).not.toContain("B internal note.")
    expect(childText).not.toContain("This fixture exists for the read-only tool tests.")

    expect(grandchildRun.parentRunId).toBe(childRun.id)
    expect(grandchildTranscript).toHaveLength(3)
    expect(grandchildTranscript.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ])
    expect(grandchildTranscript[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(grandchildTranscript[1]?.parts[0]).toMatchObject({
      kind: "text",
      text: "B internal note.",
    })
    expect(grandchildTranscript[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: README_READ_OUTPUT,
      data: {
        callId: "call_b_read",
        toolName: "read",
        output: README_READ_OUTPUT,
      },
    })
    expect(grandchildText).toContain("Read README.md and return only the nested delegated summary.")
    expect(grandchildText).toContain("B internal note.")
    expect(grandchildText).toContain("This fixture exists for the read-only tool tests.")
    expect(grandchildText).toContain("Nested summary from B.")
    expect(grandchildText).not.toContain("Delegate README inspection through nested agent work")
    expect(grandchildText).not.toContain("A internal note.")
    expect(grandchildText).not.toContain("Delegated summary from A.")

    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
    expect(harness.repository.runs.get(childRun.id).status).toBe("completed")
    expect(harness.repository.runs.get(grandchildRun.id).status).toBe("completed")
  })

  test("keeps concurrent dual subagent runtime messages isolated across sibling subsessions", async () => {
    const harness = await createHarness("subsession-isolation-runtime-concurrent", true)
    const parentPrompt = "Delegate two concurrent README inspections through the agent tool"
    const fileSnippet = "This fixture exists for the read-only tool tests."
    const branches = {
      a: {
        callId: "call_agent_a",
        prompt: "Inspect README.md for child A and return only summary A.",
        note: "Child A internal note.",
        summary: "Delegated summary from child A.",
        readCallId: "call_child_a_read",
      },
      b: {
        callId: "call_agent_b",
        prompt: "Inspect README.md for child B and return only summary B.",
        note: "Child B internal note.",
        summary: "Delegated summary from child B.",
        readCallId: "call_child_b_read",
      },
    } as const

    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_parent_concurrent",
      messageId: "message_parent_concurrent_user",
      prompt: parentPrompt,
    })

    const requests: ProviderTurnRequest[] = []
    let activeChildTurns = 0
    let maxConcurrentChildTurns = 0
    const childTurnBranches = new Set<string>()
    const childSummaryBranches = new Set<string>()

    const provider = createTurnProvider(requests, [
      async function* () {
        yield {
          type: "tool.call",
          callId: branches.a.callId,
          name: "agent",
          inputText: `{"agent":"explore","prompt":"${branches.a.prompt}"}`,
        }
        yield {
          type: "tool.call",
          callId: branches.b.callId,
          name: "agent",
          inputText: `{"agent":"explore","prompt":"${branches.b.prompt}"}`,
        }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")
        const branchKey = requestText.includes(branches.a.prompt)
          ? "a"
          : requestText.includes(branches.b.prompt)
            ? "b"
            : null

        expect(branchKey).not.toBeNull()

        const branch = branches[branchKey as keyof typeof branches]
        const other = branchKey === "a" ? branches.b : branches.a

        if (!requestText.includes(fileSnippet)) {
          childTurnBranches.add(branchKey!)
          expect(requestText).toContain(branch.prompt)
          expect(requestText).not.toContain(parentPrompt)
          expect(requestText).not.toContain(other.prompt)
          expect(requestText).not.toContain(other.note)
          expect(requestText).not.toContain(other.summary)

          activeChildTurns += 1
          maxConcurrentChildTurns = Math.max(maxConcurrentChildTurns, activeChildTurns)

          try {
            await new Promise((resolve) => setTimeout(resolve, 40))
            yield { type: "text.delta", text: branch.note }
            yield {
              type: "tool.call",
              callId: branch.readCallId,
              name: "read",
              inputText: '{"path":"README.md"}',
            }
          } finally {
            activeChildTurns -= 1
          }

          return
        }

        childSummaryBranches.add(branchKey!)
        expect(requestText).toContain(branch.prompt)
        expect(requestText).toContain(branch.note)
        expect(requestText).toContain(fileSnippet)
        expect(requestText).not.toContain(parentPrompt)
        expect(requestText).not.toContain(other.prompt)
        expect(requestText).not.toContain(other.note)
        expect(requestText).not.toContain(other.summary)

        yield { type: "text.delta", text: branch.summary }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")
        const branchKey = requestText.includes(branches.a.prompt)
          ? "a"
          : requestText.includes(branches.b.prompt)
            ? "b"
            : null

        expect(branchKey).not.toBeNull()

        const branch = branches[branchKey as keyof typeof branches]
        const other = branchKey === "a" ? branches.b : branches.a

        if (!requestText.includes(fileSnippet)) {
          childTurnBranches.add(branchKey!)
          expect(requestText).toContain(branch.prompt)
          expect(requestText).not.toContain(parentPrompt)
          expect(requestText).not.toContain(other.prompt)
          expect(requestText).not.toContain(other.note)
          expect(requestText).not.toContain(other.summary)

          activeChildTurns += 1
          maxConcurrentChildTurns = Math.max(maxConcurrentChildTurns, activeChildTurns)

          try {
            await new Promise((resolve) => setTimeout(resolve, 40))
            yield { type: "text.delta", text: branch.note }
            yield {
              type: "tool.call",
              callId: branch.readCallId,
              name: "read",
              inputText: '{"path":"README.md"}',
            }
          } finally {
            activeChildTurns -= 1
          }

          return
        }

        childSummaryBranches.add(branchKey!)
        expect(requestText).toContain(branch.prompt)
        expect(requestText).toContain(branch.note)
        expect(requestText).toContain(fileSnippet)
        expect(requestText).not.toContain(parentPrompt)
        expect(requestText).not.toContain(other.prompt)
        expect(requestText).not.toContain(other.note)
        expect(requestText).not.toContain(other.summary)

        yield { type: "text.delta", text: branch.summary }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")
        const branchKey = requestText.includes(branches.a.prompt)
          ? "a"
          : requestText.includes(branches.b.prompt)
            ? "b"
            : null

        expect(branchKey).not.toBeNull()

        const branch = branches[branchKey as keyof typeof branches]
        const other = branchKey === "a" ? branches.b : branches.a

        if (!requestText.includes(fileSnippet)) {
          childTurnBranches.add(branchKey!)
          expect(requestText).toContain(branch.prompt)
          expect(requestText).not.toContain(parentPrompt)
          expect(requestText).not.toContain(other.prompt)
          expect(requestText).not.toContain(other.note)
          expect(requestText).not.toContain(other.summary)

          activeChildTurns += 1
          maxConcurrentChildTurns = Math.max(maxConcurrentChildTurns, activeChildTurns)

          try {
            await new Promise((resolve) => setTimeout(resolve, 40))
            yield { type: "text.delta", text: branch.note }
            yield {
              type: "tool.call",
              callId: branch.readCallId,
              name: "read",
              inputText: '{"path":"README.md"}',
            }
          } finally {
            activeChildTurns -= 1
          }

          return
        }

        childSummaryBranches.add(branchKey!)
        expect(requestText).toContain(branch.prompt)
        expect(requestText).toContain(branch.note)
        expect(requestText).toContain(fileSnippet)
        expect(requestText).not.toContain(parentPrompt)
        expect(requestText).not.toContain(other.prompt)
        expect(requestText).not.toContain(other.note)
        expect(requestText).not.toContain(other.summary)

        yield { type: "text.delta", text: branch.summary }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")
        const branchKey = requestText.includes(branches.a.prompt)
          ? "a"
          : requestText.includes(branches.b.prompt)
            ? "b"
            : null

        expect(branchKey).not.toBeNull()

        const branch = branches[branchKey as keyof typeof branches]
        const other = branchKey === "a" ? branches.b : branches.a

        if (!requestText.includes(fileSnippet)) {
          childTurnBranches.add(branchKey!)
          expect(requestText).toContain(branch.prompt)
          expect(requestText).not.toContain(parentPrompt)
          expect(requestText).not.toContain(other.prompt)
          expect(requestText).not.toContain(other.note)
          expect(requestText).not.toContain(other.summary)

          activeChildTurns += 1
          maxConcurrentChildTurns = Math.max(maxConcurrentChildTurns, activeChildTurns)

          try {
            await new Promise((resolve) => setTimeout(resolve, 40))
            yield { type: "text.delta", text: branch.note }
            yield {
              type: "tool.call",
              callId: branch.readCallId,
              name: "read",
              inputText: '{"path":"README.md"}',
            }
          } finally {
            activeChildTurns -= 1
          }

          return
        }

        childSummaryBranches.add(branchKey!)
        expect(requestText).toContain(branch.prompt)
        expect(requestText).toContain(branch.note)
        expect(requestText).toContain(fileSnippet)
        expect(requestText).not.toContain(parentPrompt)
        expect(requestText).not.toContain(other.prompt)
        expect(requestText).not.toContain(other.note)
        expect(requestText).not.toContain(other.summary)

        yield { type: "text.delta", text: branch.summary }
      },
      async function* (request) {
        const requestText = readRequestText(request).join("\n")

        expect(requestText).toContain(parentPrompt)
        expect(requestText).toContain(branches.a.summary)
        expect(requestText).toContain(branches.b.summary)
        expect(requestText).not.toContain(branches.a.note)
        expect(requestText).not.toContain(branches.b.note)
        expect(requestText).not.toContain(fileSnippet)

        yield { type: "text.delta", text: "Parent finished after concurrent delegated work." }
      },
    ])

    const runtime = createRuntime({
      provider,
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const childSessions = harness.repository.sessions.listSubSessions(harness.session.id)

    expect(requests).toHaveLength(6)
    expect(childTurnBranches).toEqual(new Set(["a", "b"]))
    expect(childSummaryBranches).toEqual(new Set(["a", "b"]))
    expect(maxConcurrentChildTurns).toBe(2)
    expect(childSessions).toHaveLength(2)

    const childSessionDetails = childSessions.map((session) => {
      const transcript = harness.repository.messages.listSessionTranscript(session.id)
      const text = readTranscriptText(transcript).join("\n")
      const runs = harness.repository.runs.listBySession(session.id)

      expect(runs).toHaveLength(1)

      return {
        session,
        transcript,
        text,
        run: runs[0]!,
      }
    })

    const childA = childSessionDetails.find((detail) => detail.text.includes(branches.a.prompt))
    const childB = childSessionDetails.find((detail) => detail.text.includes(branches.b.prompt))

    expect(childA).toBeDefined()
    expect(childB).toBeDefined()
    expect(childA?.session.id).not.toBe(childB?.session.id)
    expect(childA?.run.parentRunId).toBe(started.run.id)
    expect(childB?.run.parentRunId).toBe(started.run.id)

    const parentTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const parentText = readTranscriptText(parentTranscript).join("\n")

    expect(parentTranscript).toHaveLength(3)
    expect(parentTranscript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(parentTranscript[1]?.parts.map((part) => part.kind)).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
    ])
    expect(parentTranscript[1]?.parts[2]).toMatchObject({
      kind: "tool_result",
      text: branches.a.summary,
      data: {
        callId: branches.a.callId,
        toolName: "agent",
        output: branches.a.summary,
      },
    })
    expect(parentTranscript[1]?.parts[3]).toMatchObject({
      kind: "tool_result",
      text: branches.b.summary,
      data: {
        callId: branches.b.callId,
        toolName: "agent",
        output: branches.b.summary,
      },
    })
    expect(parentText).toContain(parentPrompt)
    expect(parentText).toContain(branches.a.summary)
    expect(parentText).toContain(branches.b.summary)
    expect(parentText).toContain("Parent finished after concurrent delegated work.")
    expect(parentText).not.toContain(branches.a.note)
    expect(parentText).not.toContain(branches.b.note)
    expect(parentText).not.toContain(fileSnippet)

    expect(childA?.transcript).toHaveLength(3)
    expect(childA?.transcript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(childA?.transcript[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(childA?.text).toContain(branches.a.prompt)
    expect(childA?.text).toContain(branches.a.note)
    expect(childA?.text).toContain(fileSnippet)
    expect(childA?.text).toContain(branches.a.summary)
    expect(childA?.text).not.toContain(branches.b.prompt)
    expect(childA?.text).not.toContain(branches.b.note)
    expect(childA?.text).not.toContain(branches.b.summary)
    expect(childA?.text).not.toContain(parentPrompt)

    expect(childB?.transcript).toHaveLength(3)
    expect(childB?.transcript.map((message) => message.role)).toEqual(["user", "assistant", "assistant"])
    expect(childB?.transcript[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(childB?.text).toContain(branches.b.prompt)
    expect(childB?.text).toContain(branches.b.note)
    expect(childB?.text).toContain(fileSnippet)
    expect(childB?.text).toContain(branches.b.summary)
    expect(childB?.text).not.toContain(branches.a.prompt)
    expect(childB?.text).not.toContain(branches.a.note)
    expect(childB?.text).not.toContain(branches.a.summary)
    expect(childB?.text).not.toContain(parentPrompt)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.call.completed",
        callId: branches.a.callId,
        name: "agent",
        output: branches.a.summary,
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.call.completed",
        callId: branches.b.callId,
        name: "agent",
        output: branches.b.summary,
      }),
    )
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
    expect(harness.repository.runs.get(childA!.run.id).status).toBe("completed")
    expect(harness.repository.runs.get(childB!.run.id).status).toBe("completed")
  })

  test("source researcher loads package-qualified builtin source-note without short-name workspace fallback", async () => {
    const harness = await createHarness("source-researcher-source-note-runtime", false)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_source_researcher_source_note",
      messageId: "message_source_researcher_source_note",
      prompt: "Delegate source collection through the source researcher.",
    })
    const loadByNameCalls: string[] = []
    const loadByPathCalls: string[] = []
    const providerRequests: ProviderTurnRequest[] = []
    const store: SkillStore = {
      async listCatalog() {
        return [
          {
            name: "source-note",
            description: "Short-name workspace fallback should not win",
            path: ".ncoworker/skills/source-note/SKILL.md",
          },
          {
            name: "source-note",
            description: "Source note collector contract",
            path: "builtin:research/source-note/SKILL.md",
          },
        ]
      },
      async loadByPath(_workspaceRoot, skillPath) {
        loadByPathCalls.push(skillPath)
        return {
          name: "source-note",
          description: "Source note collector contract",
          path: skillPath,
          entryPath: "SKILL.md",
          baseDir: "file:///builtin/research/source-note/",
          source: "builtin",
          files: [],
          instructions: "Source note instructions",
        }
      },
      async loadByName(workspaceRoot, skillName) {
        loadByNameCalls.push(join(workspaceRoot, ".ncoworker", "skills", skillName, "SKILL.md"))
        throw new Error(`Short-name workspace fallback should not load ${skillName}`)
      },
      async writeSkill() {
        throw new Error("test store should not write skills")
      },
      async deleteSkill() {
        throw new Error("test store should not delete skills")
      },
    }
    const runtime = createRuntime({
      provider: createTurnProvider(providerRequests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_source_researcher",
            name: "agent",
            inputText:
              '{"agent":"source-researcher","prompt":"Collect source notes for docs and weak claims."}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")
          const systemText = request.system

          expect(requestText).toContain("Collect source notes for docs and weak claims.")
          expect(requestText).toContain("Source note instructions")
          expect(systemText).toContain("active `source-note` skill")
          expect(systemText).not.toContain("active `research/source-note` skill")

          yield { type: "text.delta", text: "structured source notes" }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Delegate source collection through the source researcher.")
          expect(requestText).toContain("structured source notes")

          yield { type: "text.delta", text: "Parent finished after source collection." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      skillRuntime: createSkillRuntimeApi({ store }),
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)

    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(loadByPathCalls).toContain("builtin:research/source-note/SKILL.md")
    expect(loadByPathCalls).not.toContain(".ncoworker/skills/source-note/SKILL.md")
    expect(loadByNameCalls).toEqual([])
    expect(loadByNameCalls).not.toContain(
      join(harness.workspaceRoot, ".ncoworker", "skills", "source-note", "SKILL.md"),
    )
  })

  test("non-source-note subagent skills preserve normal skill lookup precedence", async () => {
    const harness = await createHarness("subagent-skill-precedence-runtime", false)
    harness.repository.sessions.update({
      sessionId: harness.session.id,
      activeSkills: ["reviewer"],
    })
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_subagent_skill_precedence",
      messageId: "message_subagent_skill_precedence",
      prompt: "Delegate normal review through explore.",
    })
    const loadByNameCalls: string[] = []
    const loadByPathCalls: string[] = []
    const providerRequests: ProviderTurnRequest[] = []
    const store: SkillStore = {
      async listCatalog() {
        return [
          {
            name: "reviewer",
            description: "Workspace reviewer should win normal precedence",
            path: ".ncoworker/skills/reviewer/SKILL.md",
          },
          {
            name: "reviewer",
            description: "Builtin reviewer should not be forced",
            path: "builtin:reviewer/SKILL.md",
          },
        ]
      },
      async loadByPath(_workspaceRoot, skillPath) {
        loadByPathCalls.push(skillPath)
        if (skillPath !== ".ncoworker/skills/reviewer/SKILL.md") {
          throw new Error(`Builtin path should not be forced for reviewer: ${skillPath}`)
        }

        return {
          name: "reviewer",
          description: "Workspace reviewer should win normal precedence",
          path: skillPath,
          entryPath: "SKILL.md",
          baseDir: "file:///workspace/.ncoworker/skills/reviewer/",
          source: "workspace",
          files: [],
          instructions: "Workspace reviewer instructions",
        }
      },
      async loadByName(_workspaceRoot, skillName) {
        loadByNameCalls.push(skillName)
        return {
          name: "reviewer",
          description: "Workspace reviewer should win normal precedence",
          path: ".ncoworker/skills/reviewer/SKILL.md",
          entryPath: "SKILL.md",
          baseDir: "file:///workspace/.ncoworker/skills/reviewer/",
          source: "workspace",
          files: [],
          instructions: "Workspace reviewer instructions",
        }
      },
      async writeSkill() {
        throw new Error("test store should not write skills")
      },
      async deleteSkill() {
        throw new Error("test store should not delete skills")
      },
    }
    const runtime = createRuntime({
      provider: createTurnProvider(providerRequests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_explore",
            name: "agent",
            inputText:
              '{"agent":"explore","prompt":"Review the placeholder file with the active reviewer skill."}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")
          const systemText = request.system

          expect(requestText).toContain("Review the placeholder file with the active reviewer skill.")
          expect(requestText).toContain("Workspace reviewer instructions")
          expect(systemText).toContain("active `reviewer` skill")

          yield { type: "text.delta", text: "Workspace review complete." }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Delegate normal review through explore.")

          yield { type: "text.delta", text: "Parent finished after review." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      skillRuntime: createSkillRuntimeApi({ store }),
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)

    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
    expect(loadByPathCalls.length).toBeGreaterThan(0)
    expect(loadByPathCalls.every((path) => path === ".ncoworker/skills/reviewer/SKILL.md")).toBe(true)
    expect(loadByPathCalls).not.toContain("builtin:reviewer/SKILL.md")
    expect(loadByNameCalls).toEqual([])
  })

  test("source researcher recovers from unknown model-emitted list tool", async () => {
    const harness = await createHarness("source-researcher-unknown-tool-recovery", false)
    const started = startPromptRun({
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_source_researcher_unknown_tool_recovery",
      messageId: "message_source_researcher_unknown_tool_recovery",
      prompt: "Delegate source collection and recover from an unavailable child tool.",
    })
    const requests: ProviderTurnRequest[] = []
    const runtimeEvents: Array<{
      sessionId: string
      runId: string
      event: { type: string; [key: string]: unknown }
    }> = []
    const createStoredRunEvent = (input: {
      sessionId: string
      runId: string
      source: "model" | "orchestration" | "permission" | "tool" | "memory" | "skill"
      eventType: string
      data?: Record<string, unknown>
      createdAt?: number
    }) => ({
      id: `event_${runtimeEvents.length}`,
      sessionId: input.sessionId,
      runId: input.runId,
      sequence: runtimeEvents.length,
      source: input.source,
      eventType: input.eventType,
      data: input.data ?? {},
      createdAt: input.createdAt ?? 0,
    })
    const runtime = createRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_source_researcher",
            name: "agent",
            inputText:
              '{"agent":"source-researcher","prompt":"Collect workspace source names after correcting tool selection."}',
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_child_list",
            name: "list",
            inputText: '{"path":"."}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Tool 'list' is not available.")
          expect(requestText).toContain("Allowed tools:")
          expect(requestText).toContain("glob")
          expect(requestText).not.toContain("shell_cmd")

          yield {
            type: "tool.call",
            callId: "call_child_glob",
            name: "glob",
            inputText: '{"pattern":"**/*"}',
          }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("placeholder.txt")
          yield { type: "text.delta", text: "Child recovered with glob." }
        },
        async function* (request) {
          const requestText = readRequestText(request).join("\n")

          expect(requestText).toContain("Delegate source collection")
          expect(requestText).toContain("Child recovered with glob.")
          expect(requestText).not.toContain("Tool 'list' is not available.")

          yield { type: "text.delta", text: "Parent saw successful recovered child result." }
        },
      ]),
      repository: harness.repository,
      permissionRepository: harness.permissionRepository,
      observability: {
        runtimeObserver: {
          recordRuntimeEvent(event) {
            runtimeEvents.push(event)
            return createStoredRunEvent({
              sessionId: event.sessionId,
              runId: event.runId,
              source: "orchestration" as const,
              eventType: event.event.type,
              data: event.event,
              createdAt: event.occurredAt ?? 0,
            })
          },
        },
        modelObserver: {
          recordModelEvent(event) {
            return createStoredRunEvent({
              sessionId: event.sessionId,
              runId: event.runId,
              source: "model",
              eventType: event.type,
              data: event,
            })
          },
        },
        toolObserver: {
          recordToolEvent(event) {
            return createStoredRunEvent({
              sessionId: event.sessionId,
              runId: event.runId,
              source: "tool",
              eventType: event.type,
              data: event,
            })
          },
        },
        permissionObserver: {
          recordPermissionEvent(event) {
            return createStoredRunEvent({
              sessionId: event.sessionId,
              runId: event.runId,
              source: "permission",
              eventType: event.type,
              data: event,
            })
          },
        },
        memoryObserver: {
          recordMemoryEvent(event) {
            return createStoredRunEvent({
              sessionId: event.sessionId,
              runId: event.runId,
              source: "memory",
              eventType: event.type,
              data: event,
            })
          },
        },
        skillObserver: {
          recordSkillEvent(event) {
            return createStoredRunEvent({
              sessionId: event.sessionId,
              runId: event.runId,
              source: "skill",
              eventType: event.type,
              data: event,
            })
          },
        },
      },
      now: harness.now,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const events = await collectEvents(handle.events)
    const subSession = harness.repository.sessions.listSubSessions(harness.session.id)[0]
    const subRuns = subSession ? harness.repository.runs.listBySession(subSession.id) : []
    const subRun = subRuns[0]
    const childTranscript = subSession
      ? harness.repository.messages.listSessionTranscript(subSession.id)
      : []
    const parentTranscript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const childUnknownResult = childTranscript
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.kind === "tool_result" &&
          (part.data as { callId?: string } | undefined)?.callId === "call_child_list",
      )
    const unknownEvent = runtimeEvents.find(
      (entry) =>
        entry.runId === subRun?.id &&
        entry.event.type === "tool.call.completed" &&
        entry.event.callId === "call_child_list",
    )

    expect(requests).toHaveLength(5)
    expect(subRun).toMatchObject({ parentRunId: started.run.id, status: "completed" })
    expect(parentTranscript[1]?.parts[1]).toMatchObject({
      kind: "tool_result",
      data: {
        callId: "call_source_researcher",
        toolName: "agent",
        output: "Child recovered with glob.",
      },
    })
    expect(childUnknownResult).toMatchObject({
      kind: "tool_result",
      text: expect.stringContaining("Tool 'list' is not available."),
      data: {
        callId: "call_child_list",
        toolName: "list",
        output: expect.stringContaining("Allowed tools:"),
        isError: true,
        metadata: expect.objectContaining({
          [TOOL_RECOVERABLE_UNKNOWN_METADATA_KEY]: true,
          [TOOL_UNKNOWN_ALLOWED_NAMES_METADATA_KEY]: expect.arrayContaining(["glob", "grep", "read"]),
        }),
      },
    })
    expect(unknownEvent?.event).toMatchObject({
      type: "tool.call.completed",
      callId: "call_child_list",
      name: "list",
      isError: true,
      recoverable: true,
      attemptedTool: "list",
      allowedTools: expect.arrayContaining(["glob", "grep", "read"]),
    })
    expect(events.map((event) => event.type)).not.toContain("subagent.failed")
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent.completed" }))
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: started.run.id })
  })

})

async function createHarness(prefix: string, withFixtureWorkspace: boolean) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  if (withFixtureWorkspace) {
    await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })
  } else {
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(join(workspaceRoot, "placeholder.txt"), "placeholder")
  }

  const now = createMonotonicClock()
  const database = trackDatabase(openStorageDatabase(join(directory, "agent.sqlite")))
  const repository = createStorageRepository({
    database,
    now,
  })
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const service = createSessionRunService({
    repository,
    now,
  })
  const session = repository.sessions.create({
    id: `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    repository,
    permissionRepository,
    service,
    session,
    workspaceRoot,
    now,
  }
}

function startPromptRun(input: {
  repository: StorageRepository
  permissionRepository: PermissionRepository
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
  messageId: string
  prompt: string
}) {
  const started = input.service.startRun({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
  })

  input.repository.parts.create({
    sessionId: input.sessionId,
    runId: started.run.id,
    messageId: started.message.id,
    kind: "text",
    sequence: 0,
    text: input.prompt,
  })

  return started
}

function createTurnProvider(
  requests: ProviderTurnRequest[],
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
) {
  let index = 0

  return createModelProvider({
    runtime: createModelRuntimeApi({
      async *streamTurn(request: ProviderTurnRequest) {
        requests.push(request)
        const turn = turns[index]
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

async function collectEvents<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function readRequestText(request: ProviderTurnRequest) {
  return ((request.messages as Array<{ parts?: Array<Record<string, unknown>> }> | undefined) ?? []).flatMap(
    (message) =>
      (message.parts ?? []).flatMap((part) => {
        if (part.type === "text" && typeof part.text === "string") {
          return [part.text]
        }

        if (part.type === "tool_result" && typeof part.output === "string") {
          return [part.output]
        }

        return []
      }),
  )
}

function readTranscriptText(
  transcript: Array<{ parts: Array<{ kind: string; text: string | null }> }>,
) {
  return transcript.flatMap((message) =>
    message.parts.flatMap((part) =>
      (part.kind === "text" || part.kind === "tool_result") && typeof part.text === "string"
        ? [part.text]
        : [],
    ),
  )
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}

function estimateProviderTurnInputTokens(request: ProviderTurnRequest) {
  return estimateModelTurnUsage({
    request: {
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    outputEvents: [],
  }).inputTokens
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
