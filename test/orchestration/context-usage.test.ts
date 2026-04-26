import { describe, expect, test } from "bun:test"
import { buildContextUsageSnapshot } from "../../src/orchestration"

describe("context usage", () => {
  test("normalizes invalid token counts before calculating utilization", () => {
    expect(
      buildContextUsageSnapshot({
        contextTokens: Number.NaN,
        contextWindow: 204_800,
        source: "provider",
      }),
    ).toEqual({
      contextTokens: 0,
      contextWindow: 204_800,
      utilizationPercent: 0,
      source: "provider",
    })
  })
})
