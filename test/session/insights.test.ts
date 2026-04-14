import { describe, expect, test } from "bun:test"

import { summarizeSessionInsights, type SessionInsight } from "../../src/session"

describe("summarizeSessionInsights", () => {
  test("returns a zero summary for empty input", () => {
    expect(summarizeSessionInsights([])).toEqual({
      totalSessions: 0,
      totalTokens: {
        input: 0,
        output: 0,
      },
      topTools: [],
      avgTurnsPerSession: 0,
      avgTokensPerSession: 0,
    })
  })

  test("aggregates a single session correctly", () => {
    const insights: SessionInsight[] = [
      createInsight({
        sessionId: "session_1",
        totalTokens: { input: 120, output: 30 },
        toolUsage: new Map([
          ["read", 3],
          ["glob", 1],
        ]),
        turnCount: 4,
        compactionCount: 1,
      }),
    ]

    expect(summarizeSessionInsights(insights)).toEqual({
      totalSessions: 1,
      totalTokens: {
        input: 120,
        output: 30,
      },
      topTools: [
        { name: "read", count: 3 },
        { name: "glob", count: 1 },
      ],
      avgTurnsPerSession: 4,
      avgTokensPerSession: 150,
    })
  })

  test("aggregates totals across multiple sessions", () => {
    const insights: SessionInsight[] = [
      createInsight({
        sessionId: "session_1",
        totalTokens: { input: 10, output: 5 },
        toolUsage: new Map([["read", 2]]),
        turnCount: 2,
      }),
      createInsight({
        sessionId: "session_2",
        totalTokens: { input: 25, output: 15 },
        toolUsage: new Map([
          ["read", 1],
          ["bash", 4],
        ]),
        turnCount: 6,
      }),
      createInsight({
        sessionId: "session_3",
        totalTokens: { input: 5, output: 0 },
        toolUsage: new Map([["glob", 3]]),
        turnCount: 1,
      }),
    ]

    expect(summarizeSessionInsights(insights)).toEqual({
      totalSessions: 3,
      totalTokens: {
        input: 40,
        output: 20,
      },
      topTools: [
        { name: "bash", count: 4 },
        { name: "glob", count: 3 },
        { name: "read", count: 3 },
      ],
      avgTurnsPerSession: 3,
      avgTokensPerSession: 20,
    })
  })

  test("orders top tools by count descending then name ascending", () => {
    const insights: SessionInsight[] = [
      createInsight({
        sessionId: "session_1",
        toolUsage: new Map([
          ["read", 3],
          ["bash", 4],
          ["glob", 1],
        ]),
      }),
      createInsight({
        sessionId: "session_2",
        toolUsage: new Map([
          ["read", 3],
          ["bash", 2],
          ["write", 2],
        ]),
      }),
    ]

    expect(summarizeSessionInsights(insights).topTools).toEqual([
      { name: "bash", count: 6 },
      { name: "read", count: 6 },
      { name: "write", count: 2 },
      { name: "glob", count: 1 },
    ])
  })
})

function createInsight(overrides: Partial<SessionInsight> & Pick<SessionInsight, "sessionId">): SessionInsight {
  return {
    sessionId: overrides.sessionId,
    startedAt: overrides.startedAt ?? new Date("2026-04-15T00:00:00.000Z"),
    endedAt: overrides.endedAt,
    totalTokens: overrides.totalTokens ?? { input: 0, output: 0 },
    toolUsage: overrides.toolUsage ?? new Map(),
    turnCount: overrides.turnCount ?? 0,
    compactionCount: overrides.compactionCount ?? 0,
  }
}
