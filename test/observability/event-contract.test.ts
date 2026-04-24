import { describe, expect, test } from "bun:test"
import {
  TELEMETRY_CONTRACT_EVENT_NAMES,
  TELEMETRY_CONTRACT_EVENTS,
  createAgentSwitchedPayload,
  createAppStatePathResolvedPayload,
  createBuiltinSkillMaterializedPayload,
  createDeepResearchSubagentsPlannedPayload,
  createObservabilityRuntimeApi,
  createResearchArtifactWrittenPayload,
  createSkillActivatedPayload,
  type CreateRunEventInput,
  type StoredRunEvent,
} from "../../src/observability"

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

describe("observability event contract", () => {
  test("defines exact T4 contract event names without replacing dotted legacy names", () => {
    expect(TELEMETRY_CONTRACT_EVENT_NAMES).toEqual([
      "app_state_path_resolved",
      "builtin_skill_materialized",
      "skill_activated",
      "agent_switched",
      "deep_research_subagents_planned",
      "research_artifact_written",
    ])
  })

  test("captures representative contract events through runtime and skill observer seams", () => {
    const harness = createRepository()
    const runtime = createObservabilityRuntimeApi({
      repository: harness.repository,
      now: () => 42,
    })

    runtime.skillObserver.recordSkillEvent({
      sessionId: "session_1",
      runId: "run_1",
      type: TELEMETRY_CONTRACT_EVENTS.builtinSkillMaterialized,
      payload: createBuiltinSkillMaterializedPayload({
        skillName: "deep-research",
        packageRelativePath: "skills/deep-research/SKILL.md",
        source: "builtin",
      }),
    })
    runtime.skillObserver.recordSkillEvent({
      sessionId: "session_1",
      runId: "run_1",
      type: TELEMETRY_CONTRACT_EVENTS.skillActivated,
      payload: createSkillActivatedPayload({
        skillName: "deep-research",
        activeSkillNames: ["deep-research"],
        activeSkillCount: 1,
        source: "global",
      }),
    })
    runtime.runtimeObserver.recordRuntimeEvent({
      sessionId: "session_1",
      runId: "run_1",
      event: {
        type: TELEMETRY_CONTRACT_EVENTS.agentSwitched,
        ...createAgentSwitchedPayload({
          fromAgent: "default",
          toAgent: "deep-research",
          trigger: "user",
        }),
      },
    })

    expect(harness.runEvents).toEqual([
      expect.objectContaining({
        source: "skill",
        eventType: "builtin_skill_materialized",
        data: {
          payload: {
            skillName: "deep-research",
            packageRelativePath: "skills/deep-research/SKILL.md",
            source: "builtin",
          },
        },
      }),
      expect.objectContaining({
        source: "skill",
        eventType: "skill_activated",
        data: {
          payload: {
            skillName: "deep-research",
            activeSkillNames: ["deep-research"],
            activeSkillCount: 1,
            source: "global",
          },
        },
      }),
      expect.objectContaining({
        source: "orchestration",
        eventType: "agent_switched",
        data: {
          fromAgent: "default",
          toAgent: "deep-research",
          trigger: "user",
        },
      }),
    ])
  })

  test("builds safe metadata payloads for path, research planning, and artifact events", () => {
    const pathPayload = createAppStatePathResolvedPayload({
      pathRoot: "config",
      pathKind: "agents",
      relativePath: "agents",
    })
    const planPayload = createDeepResearchSubagentsPlannedPayload({
      topicSlug: "runtime-observability",
      plannedCount: 2,
      subagentKinds: ["web", "docs"],
    })
    const artifactTelemetryInput = {
      topicSlug: "runtime-observability",
      artifactKind: "findings" as const,
      workspaceRelativePath: ".ncoworker/research/runtime-observability/findings/F001.md",
      body: "PRIVATE SOURCE EXCERPT should not be recorded",
      excerpt: "private file contents should not be recorded",
    }
    const artifactPayload = createResearchArtifactWrittenPayload(artifactTelemetryInput)

    expect(pathPayload).toEqual({
      pathRoot: "config",
      pathKind: "agents",
      relativePath: "agents",
    })
    expect(planPayload).toEqual({
      topicSlug: "runtime-observability",
      plannedCount: 2,
      subagentKinds: ["web", "docs"],
    })
    expect(artifactPayload).toEqual({
      topicSlug: "runtime-observability",
      artifactKind: "findings",
      workspaceRelativePath: ".ncoworker/research/runtime-observability/findings/F001.md",
    })

    const serializedPayloads = JSON.stringify([pathPayload, planPayload, artifactPayload])
    expect(serializedPayloads).not.toContain("PRIVATE SOURCE EXCERPT")
    expect(serializedPayloads).not.toContain("private file contents")
    expect(serializedPayloads).not.toContain(process.env.HOME ?? "/home")
  })

  test("rejects artifact telemetry paths outside the research artifact root", () => {
    expect(() =>
      createResearchArtifactWrittenPayload({
        topicSlug: "runtime-observability",
        artifactKind: "finding",
        workspaceRelativePath: "src/private-notes.md",
      }),
    ).toThrow("Research artifact telemetry path must be under .ncoworker/research/.")
  })

  test("rejects skill activation payloads with invalid sources or inconsistent counts", () => {
    expect(() =>
      createSkillActivatedPayload({
        skillName: "deep-research",
        activeSkillNames: ["deep-research"],
        activeSkillCount: 1,
        source: "user",
      }),
    ).toThrow("Skill source must be one of builtin, global, workspace.")

    expect(() =>
      createSkillActivatedPayload({
        skillName: "deep-research",
        activeSkillNames: ["deep-research", "memory"],
        activeSkillCount: 1,
        source: "workspace",
      }),
    ).toThrow("Active skill count must equal active skill names length.")
  })

  test("rejects deep research fanout counts outside the adaptive planning contract", () => {
    expect(() =>
      createDeepResearchSubagentsPlannedPayload({
        topicSlug: "runtime-observability",
        plannedCount: 1,
        subagentKinds: ["web", "docs"],
      }),
    ).toThrow("Planned subagent count must equal subagent kinds length.")

    expect(() =>
      createDeepResearchSubagentsPlannedPayload({
        topicSlug: "runtime-observability",
        plannedCount: 6,
        subagentKinds: ["web", "docs", "files", "synthesis", "web", "docs"],
      }),
    ).toThrow("Planned subagent count must be between 0 and 5.")
  })
})
