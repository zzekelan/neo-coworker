import { describe, expect, test } from "bun:test"
import {
  TurnBudget,
  TURN_BUDGET_PREVIEW_LENGTH,
  type ToolObserverEvent,
} from "../../src/tool"

describe("turn budget", () => {
  test("stays under budget without spilling", () => {
    const budget = new TurnBudget(50)

    budget.track("read", "small result")

    expect(budget.isOverBudget()).toBe(false)
    expect(
      budget.spillLargest(createResultStoreStub()),
    ).toEqual([])
  })

  test("emits over-budget telemetry only on first threshold crossing", () => {
    const events: ToolObserverEvent[] = []
    const budget = new TurnBudget({
      maxChars: 10,
      observer: createObserver(events),
      observerContext: { sessionId: "session-1", runId: "run-1" },
    })

    budget.track("read", "12345")
    budget.track("glob", "678901")
    budget.track("grep", "more")

    const overBudgetEvents = events.filter((event) => event.type === "budget.turn_over_budget")
    expect(overBudgetEvents).toHaveLength(1)
    expect(overBudgetEvents[0]).toEqual({
      type: "budget.turn_over_budget",
      sessionId: "session-1",
      runId: "run-1",
      payload: {
        turnCumulativeSize: 11,
        maxChars: 10,
        trackedToolCount: 2,
      },
    })
  })

  test("spills the largest tracked result first and emits spill telemetry", () => {
    const events: ToolObserverEvent[] = []
    const saves: Array<{ content: string; toolName: string }> = []
    const largeResult = "x".repeat(700)
    const budget = new TurnBudget({
      maxChars: 650,
      observer: createObserver(events),
      observerContext: { sessionId: "session-2", runId: "run-2" },
    })

    budget.track("read", "small")
    budget.track("glob", largeResult)

    const spills = budget.spillLargest(createResultStoreStub({
      onSave(content, toolName) {
        saves.push({ content, toolName })
      },
    }))

    expect(saves).toEqual([{ content: largeResult, toolName: "glob" }])
    expect(spills).toHaveLength(1)
    expect(spills[0]).toMatchObject({
      position: 1,
      toolName: "glob",
      path: ".ncoworker/tool-results/glob/1.txt",
      originalSize: 700,
    })
    expect(spills[0]?.output).toContain("[Result spilled to .ncoworker/tool-results/glob/1.txt")

    const spillEvents = events.filter((event) => event.type === "budget.spill_largest")
    expect(spillEvents).toEqual([
      {
        type: "budget.spill_largest",
        sessionId: "session-2",
        runId: "run-2",
        payload: {
          toolName: "glob",
          spilledSize: 700,
          previewLength: TURN_BUDGET_PREVIEW_LENGTH,
          diskPath: ".ncoworker/tool-results/glob/1.txt",
          remainingBudget: 48,
        },
      },
    ])
  })

  test("repeatedly spills largest results until the budget is back under limit", () => {
    const budget = new TurnBudget(1400)

    budget.track("read", "a".repeat(900))
    budget.track("glob", "b".repeat(850))
    budget.track("grep", "c".repeat(200))

    const spills = budget.spillLargest(createResultStoreStub())

    expect(spills).toHaveLength(2)
    expect(spills.map((spill) => spill.toolName)).toEqual(["read", "glob"])
    expect(budget.isOverBudget()).toBe(false)
  })

  test("reset clears tracked state for a new turn", () => {
    const events: ToolObserverEvent[] = []
    const budget = new TurnBudget({
      maxChars: 5,
      observer: createObserver(events),
      observerContext: { sessionId: "session-3", runId: "run-3" },
    })

    budget.track("read", "123456")
    expect(budget.isOverBudget()).toBe(true)

    budget.reset()

    expect(budget.isOverBudget()).toBe(false)
    expect(budget.spillLargest(createResultStoreStub())).toEqual([])

    budget.track("glob", "abcdef")
    const overBudgetEvents = events.filter((event) => event.type === "budget.turn_over_budget")
    expect(overBudgetEvents).toHaveLength(2)
    expect(overBudgetEvents[1]).toEqual({
      type: "budget.turn_over_budget",
      sessionId: "session-3",
      runId: "run-3",
      payload: {
        turnCumulativeSize: 6,
        maxChars: 5,
        trackedToolCount: 1,
      },
    })
  })
})

function createObserver(events: ToolObserverEvent[]) {
  return {
    recordToolEvent(event: ToolObserverEvent) {
      events.push(event)
    },
  }
}

function createResultStoreStub(input?: {
  onSave?: (content: string, toolName: string) => void
}) {
  let count = 0

  return {
    save(content: string, toolName: string) {
      count += 1
      input?.onSave?.(content, toolName)
      return {
        path: `.ncoworker/tool-results/${toolName}/${count}.txt`,
      }
    },
  }
}
