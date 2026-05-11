import { describe, expect, test } from "bun:test"

import {
  EvalRunArtifactSchema,
  gradeTraceDataExpectation,
  gradeTraceExpectation,
  gradeToolConsumptionExpectation,
  gradeTimelineExpectation,
  type EvalRunArtifact,
} from "../../evals"

describe("eval content artifacts", () => {
  test("content graders read Session Timeline content directly", () => {
    const artifact = buildArtifact({
      timeline: [
        buildTimelineEntry({
          id: "entry_tool",
          timelineSequence: 0,
          parts: [
            {
              id: "part_tool_result",
              sessionId: "session_1",
              producedByRunId: "run_1",
              entryId: "entry_tool",
              kind: "tool_result",
              sequence: 0,
              text: "timeline result payload",
              data: {
                toolName: "read",
                output: "timeline result payload",
              },
              createdAt: 2,
            },
          ],
        }),
        buildTimelineEntry({
          id: "entry_answer",
          timelineSequence: 1,
          runSequence: 1,
          parts: [
            {
              id: "part_answer",
              sessionId: "session_1",
              producedByRunId: "run_1",
              entryId: "entry_answer",
              kind: "text",
              sequence: 0,
              text: "timeline answer consumed the result",
              data: null,
              createdAt: 3,
            },
          ],
        }),
      ],
    })

    expect(
      gradeTimelineExpectation({
        artifact,
        expectation: {
          orderedTextIncludes: ["timeline answer"],
          checkpoints: [
            {
              messageIndex: 1,
              role: "assistant",
              textIncludes: ["consumed the result"],
              partKinds: ["text"],
              toolNames: [],
            },
          ],
        },
      }),
    ).toMatchObject({
      pass: true,
      observedTexts: expect.arrayContaining(["timeline answer consumed the result"]),
      missingOrderedTexts: [],
      checkpointFailures: [],
    })

    expect(
      gradeToolConsumptionExpectation({
        artifact,
        expectation: {
          requiredConsumptions: [
            {
              toolName: "read",
              toolResultIncludes: ["timeline result payload"],
              assistantTextIncludes: ["consumed the result"],
            },
          ],
        },
      }),
    ).toEqual({
      pass: true,
      failures: [],
    })
  })

  test("execution graders keep reading per-run trace artifacts instead of timeline content", () => {
    const artifact = buildArtifact({
      timeline: [
        buildTimelineEntry({
          parts: [
            {
              id: "part_tool_call",
              sessionId: "session_1",
              producedByRunId: "run_1",
              entryId: "entry_1",
              kind: "tool_call",
              sequence: 0,
              text: null,
              data: {
                toolName: "read",
                eventType: "tool.call.completed",
              },
              createdAt: 2,
            },
          ],
        }),
      ],
      trace: {
        sessionId: "session_1",
        runId: "run_1",
        events: [
          {
            sequence: 0,
            source: "orchestration",
            eventType: "model.prompt.assembled",
            createdAt: 4,
            data: {
              turnKey: "run_1:0",
            },
          },
        ],
      },
    })

    expect(
      gradeTraceExpectation({
        artifact,
        expectation: {
          requiredEventTypes: ["tool.call.completed"],
        },
      }),
    ).toMatchObject({
      pass: false,
      missingEventTypes: ["tool.call.completed"],
    })

    expect(
      gradeTraceDataExpectation({
        artifact,
        expectation: {
          events: [
            {
              eventType: "model.prompt.assembled",
              fields: [{ field: "turnKey", equalsString: "run_1:0" }],
            },
          ],
        },
      }),
    ).toEqual({
      pass: true,
      failures: [],
    })
  })
})

function buildArtifact(overrides: Partial<EvalRunArtifact> = {}) {
  return EvalRunArtifactSchema.parse({
    taskId: "timeline-content",
    workspaceRoot: "/workspace",
    sessionId: "session_1",
    runId: "run_1",
    provider: {
      mode: "scripted",
      kind: "scripted",
      model: null,
    },
    runStatus: "completed",
    runtimeEvents: [],
    timeline: [],
    trace: null,
    runs: [
      {
        stepIndex: 0,
        runId: "run_1",
        trigger: "cli",
        status: "completed",
        errorText: null,
        inputTokens: 0,
        outputTokens: 0,
        tokenUsageSource: null,
        runtimeEvents: [],
        trace: null,
      },
    ],
    outcome: {
      runStatus: "completed",
      errorText: null,
      watchedFiles: [],
    },
    metrics: {
      totalRunDurationMs: null,
      modelTurnCount: 0,
      toolCallCount: 0,
      permissionWaitCount: 0,
      retryCount: 0,
      terminalEventType: "run.completed",
    },
    ...overrides,
  })
}

function buildTimelineEntry(
  overrides: {
    id?: string
    timelineSequence?: number
    runSequence?: number
    parts?: unknown[]
  } = {},
) {
  const id = overrides.id ?? "entry_1"

  return {
    id,
    sessionId: "session_1",
    producedByRunId: "run_1",
    agent: "general",
    role: "assistant",
    runSequence: overrides.runSequence ?? 0,
    timelineSequence: overrides.timelineSequence ?? 0,
    createdAt: 1,
    parts: overrides.parts ?? [],
  }
}
