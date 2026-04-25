import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getBuiltinAgent } from "../../src/agent"
import {
  TELEMETRY_CONTRACT_EVENTS,
  createAgentSwitchedPayload,
  createBuiltinSkillMaterializedPayload,
  createDeepResearchSubagentsPlannedPayload,
  createObservabilityRuntimeApi,
  createResearchArtifactWrittenPayload,
  createSkillActivatedPayload,
  type CreateRunEventInput,
  type ResearchArtifactWrittenPayload,
  type StoredRunEvent,
} from "../../src/observability"
import { materializeBuiltinSkills } from "../../src/skill"
import {
  collectSourceNoteCandidate,
  readResearchTree,
  runPrimaryResearchArtifactWorkflow,
  type SourceNoteCandidate,
} from "../research/deep-research-artifacts"

function createRepository() {
  const runEvents: StoredRunEvent[] = []

  return {
    repository: {
      runEvents: {
        append(input: CreateRunEventInput) {
          const record: StoredRunEvent = {
            id: input.id ?? `event_${runEvents.length + 1}`,
            sessionId: input.sessionId,
            runId: input.runId,
            sequence: runEvents.length,
            source: input.source,
            eventType: input.eventType,
            data: input.data ?? {},
            createdAt: input.createdAt ?? 0,
          }
          runEvents.push(record)
          return record
        },
        listByRun(runId: string) {
          return runEvents.filter((event) => event.runId === runId)
        },
      },
    },
    runEvents,
  }
}

async function createWorkspace(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix))
}

describe("workflow telemetry contract", () => {
  test("records built-in skill materialization, skill activation, and agent switch payloads as metadata only", async () => {
    const dataRoot = await createWorkspace("ncoworker-telemetry-data-")
    const materialized = await materializeBuiltinSkills({ dataRoot })
    const deepResearchPackage = materialized.packages.find(
      (pkg) => pkg.category === "research" && pkg.name === "deep-research",
    )
    const generalAgent = getBuiltinAgent("general")
    const deepResearchAgent = getBuiltinAgent("deep-research")

    expect(deepResearchPackage).toBeDefined()
    expect(getBuiltinAgent("default")).toBeUndefined()
    expect(generalAgent?.name).toBe("general")
    expect(generalAgent?.displayName).toBe("General")
    expect(deepResearchAgent?.name).toBe("deep-research")
    expect(deepResearchAgent?.description).toBe("Deep Research")
    expect(deepResearchAgent?.skills).toEqual(["research/deep-research", "research/finding-synthesis"])

    const harness = createRepository()
    const runtime = createObservabilityRuntimeApi({
      repository: harness.repository,
      now: () => 42,
    })
    const activeSkillNames = deepResearchAgent?.skills ?? []

    runtime.skillObserver.recordSkillEvent({
      sessionId: "session_telemetry",
      runId: "run_skills",
      type: TELEMETRY_CONTRACT_EVENTS.builtinSkillMaterialized,
      payload: createBuiltinSkillMaterializedPayload({
        skillName: `${deepResearchPackage?.category}/${deepResearchPackage?.name}`,
        packageRelativePath: deepResearchPackage?.entryPath ?? "research/deep-research/SKILL.md",
        source: "builtin",
      }),
    })
    runtime.skillObserver.recordSkillEvent({
      sessionId: "session_telemetry",
      runId: "run_skills",
      type: TELEMETRY_CONTRACT_EVENTS.skillActivated,
      payload: createSkillActivatedPayload({
        skillName: activeSkillNames[0],
        activeSkillNames,
        activeSkillCount: activeSkillNames.length,
        source: "builtin",
      }),
    })
    runtime.runtimeObserver.recordRuntimeEvent({
      sessionId: "session_telemetry",
      runId: "run_skills",
      event: {
        type: TELEMETRY_CONTRACT_EVENTS.agentSwitched,
        ...createAgentSwitchedPayload({
          fromAgent: generalAgent?.name ?? "general",
          toAgent: deepResearchAgent?.name ?? "deep-research",
          trigger: "user",
        }),
      },
    })

    expect(harness.runEvents.map((event) => event.eventType)).toEqual([
      "builtin_skill_materialized",
      "skill_activated",
      "agent_switched",
    ])
    expect(harness.runEvents).toEqual([
      expect.objectContaining({
        source: "skill",
        data: {
          payload: {
            skillName: "research/deep-research",
            packageRelativePath: "research/deep-research/SKILL.md",
            source: "builtin",
          },
        },
      }),
      expect.objectContaining({
        source: "skill",
        data: {
          payload: {
            skillName: "research/deep-research",
            activeSkillNames: ["research/deep-research", "research/finding-synthesis"],
            activeSkillCount: 2,
            source: "builtin",
          },
        },
      }),
      expect.objectContaining({
        source: "orchestration",
        data: {
          fromAgent: "general",
          toAgent: "deep-research",
          trigger: "user",
        },
      }),
    ])

    const supportReferenceBody = await readFile(
      join(dataRoot, "builtin-skills/research/deep-research/references/artifact-schema.md"),
      "utf8",
    )
    const serializedEvents = JSON.stringify(harness.runEvents)
    expect(serializedEvents).not.toContain("Topic brief fields, in order")
    expect(serializedEvents).not.toContain(supportReferenceBody)
    expect(serializedEvents).not.toContain("Reference files:")
    expect(serializedEvents).not.toContain("instructions")
    expect(serializedEvents).not.toContain("files\":")
  })

  test("records Deep Research planning and artifact write telemetry from artifact workflow paths", async () => {
    const workspaceRoot = await createWorkspace("ncoworker-telemetry-research-")
    const privateSourcePath = join(workspaceRoot, "fixtures/private-security-notes.pdf")
    const privateFileContents = "%PDF-1.4\nprivate file content that must stay outside telemetry"
    await mkdir(join(workspaceRoot, "fixtures"), { recursive: true })
    await writeFile(privateSourcePath, privateFileContents, "utf8")

    const sourceNotes = [
      collectSourceNoteCandidate({
        proposedType: "web",
        title: "Telemetry guide",
        uriOrPath: "https://example.com/telemetry-guide",
        retrievedAt: "2026-04-25",
        reliability: "Maintained product guide.",
        relevance: "Describes metadata-only event payloads.",
        supports: ["Telemetry payloads can describe actions without copying source bodies."],
        contradicts: [],
        keyExcerpts: ["metadata-only event payloads"],
        caveats: ["Confirm implementation-specific event names."],
        suggestedTags: ["telemetry"],
        accepted: true,
      }),
      collectSourceNoteCandidate({
        proposedType: "files",
        title: "Private security notes PDF",
        uriOrPath: privateSourcePath,
        retrievedAt: "2026-04-25",
        reliability: "Private local notes.",
        relevance: "Reference-only local file metadata.",
        supports: ["Private files should remain reference-only."],
        contradicts: [],
        keyExcerpts: ["reference-only private file metadata"],
        caveats: ["Do not emit private file contents."],
        suggestedTags: ["files"],
        accepted: true,
        contentHash: "sha256-telemetry-private-file",
      }),
    ] satisfies SourceNoteCandidate[]
    const result = await runPrimaryResearchArtifactWorkflow(workspaceRoot, {
      topic: "Telemetry Payload Privacy",
      title: "Telemetry payload privacy",
      summary: "Evidence that workflow telemetry remains metadata-only.",
      updated: "2026-04-25",
      tags: ["telemetry", "privacy"],
      finding: {
        claim: "Workflow telemetry can cite artifact paths without copying source contents.",
        scope: "Deep Research artifact writes.",
        confidence: "high",
        notes: "Telemetry uses event names, topic slugs, artifact kinds, and workspace-relative paths.",
      },
      sourceNotes,
    })
    const researchTree = await readResearchTree(workspaceRoot)

    const harness = createRepository()
    const runtime = createObservabilityRuntimeApi({
      repository: harness.repository,
      now: () => 42,
    })
    const plannedPayload = createDeepResearchSubagentsPlannedPayload({
      topicSlug: result.topicSlug,
      plannedCount: sourceNotes.length,
      subagentKinds: sourceNotes.map((note) => note.proposedType),
    })
    runtime.runtimeObserver.recordRuntimeEvent({
      sessionId: "session_telemetry",
      runId: "run_research",
      event: {
        type: TELEMETRY_CONTRACT_EVENTS.deepResearchSubagentsPlanned,
        ...plannedPayload,
      },
    })

    const artifactPayloads = result.writtenPaths.map((workspaceRelativePath) => {
      const input = {
        topicSlug: result.topicSlug,
        artifactKind: inferArtifactKind(workspaceRelativePath),
        workspaceRelativePath,
        body: researchTree[workspaceRelativePath],
        excerpt: sourceNotes.flatMap((note) => note.keyExcerpts).join("\n"),
        privateFileContents,
      }
      return createResearchArtifactWrittenPayload(input)
    })

    for (const payload of artifactPayloads) {
      runtime.runtimeObserver.recordRuntimeEvent({
        sessionId: "session_telemetry",
        runId: "run_research",
        event: {
          type: TELEMETRY_CONTRACT_EVENTS.researchArtifactWritten,
          ...payload,
        },
      })
    }

    expect(plannedPayload).toEqual({
      topicSlug: "telemetry-payload-privacy",
      plannedCount: 2,
      subagentKinds: ["web", "files"],
    })
    expect(artifactPayloads).toContainEqual({
      topicSlug: "telemetry-payload-privacy",
      artifactKind: "source",
      workspaceRelativePath:
        ".ncoworker/research/telemetry-payload-privacy/sources/files/F001-private-security-notes-pdf.md",
    })
    expect(harness.runEvents.map((event) => event.eventType)).toEqual([
      "deep_research_subagents_planned",
      ...result.writtenPaths.map(() => "research_artifact_written"),
    ])
    expect(harness.runEvents.every((event) => event.source === "orchestration")).toBe(true)

    const serializedEvents = JSON.stringify(harness.runEvents)
    expect(serializedEvents).toContain("topicSlug")
    expect(serializedEvents).toContain("artifactKind")
    expect(serializedEvents).toContain("workspaceRelativePath")
    expect(serializedEvents).not.toContain(privateFileContents)
    expect(serializedEvents).not.toContain("body")
    expect(serializedEvents).not.toContain("excerpt")
    expect(serializedEvents).not.toContain("privateFileContents")
    expect(serializedEvents).not.toContain("reference-only private file metadata")
  })
})

function inferArtifactKind(workspaceRelativePath: string): ResearchArtifactWrittenPayload["artifactKind"] {
  if (workspaceRelativePath === ".ncoworker/research/index.md") {
    return "index"
  }
  if (workspaceRelativePath.endsWith("/brief.md")) {
    return "brief"
  }
  if (workspaceRelativePath.endsWith("/findings.md")) {
    return "findings"
  }
  if (workspaceRelativePath.endsWith("/open-questions.md")) {
    return "open-questions"
  }
  if (workspaceRelativePath.endsWith("/sources/index.md")) {
    return "sources-index"
  }
  if (workspaceRelativePath.includes("/sources/")) {
    return "source"
  }
  return "topic"
}
