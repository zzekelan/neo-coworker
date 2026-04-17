import type { ToolObserverPort } from "./ports/tool-observer"

const DEFAULT_TURN_BUDGET_MAX_CHARS = 200_000
const TURN_BUDGET_PREVIEW_LENGTH = 500

type ResultStoreSaveResult = {
  path: string
}

type ResultStorePort = {
  save(content: string, toolName: string): ResultStoreSaveResult | undefined
}

type TrackedResult = {
  position: number
  toolName: string
  content: string
  size: number
  spilled: boolean
}

export type TurnBudgetSpillResult = {
  position: number
  toolName: string
  path: string
  output: string
  originalSize: number
  previewSize: number
}

type TurnBudgetObserverContext = {
  sessionId: string
  runId: string
}

type TurnBudgetOptions = {
  maxChars?: number
  observer?: ToolObserverPort
  observerContext?: TurnBudgetObserverContext
}

export class TurnBudget {
  private readonly trackedResults: TrackedResult[] = []

  private totalSize = 0

  private readonly maxChars: number

  private readonly observer?: ToolObserverPort

  private readonly observerContext?: TurnBudgetObserverContext

  private overBudgetEmitted = false

  constructor(input: number | TurnBudgetOptions = DEFAULT_TURN_BUDGET_MAX_CHARS) {
    if (typeof input === "number") {
      this.maxChars = input
      return
    }

    this.maxChars = input.maxChars ?? DEFAULT_TURN_BUDGET_MAX_CHARS
    this.observer = input.observer
    this.observerContext = input.observerContext
  }

  track(toolName: string, resultContent: string) {
    const size = resultContent.length

    this.trackedResults.push({
      position: this.trackedResults.length,
      toolName,
      content: resultContent,
      size,
      spilled: false,
    })
    this.totalSize += size

    if (this.totalSize > this.maxChars && !this.overBudgetEmitted) {
      this.overBudgetEmitted = true
      this.emitObserverEvent({
        type: "budget.turn_over_budget",
        payload: {
          turnCumulativeSize: this.totalSize,
          maxChars: this.maxChars,
          trackedToolCount: this.trackedResults.length,
        },
      })
    }
  }

  isOverBudget() {
    return this.totalSize > this.maxChars
  }

  reset() {
    this.trackedResults.splice(0, this.trackedResults.length)
    this.totalSize = 0
    this.overBudgetEmitted = false
  }

  spillLargest(resultStore: ResultStorePort): TurnBudgetSpillResult[] {
    const spills: TurnBudgetSpillResult[] = []

    while (this.isOverBudget()) {
      const candidate = this.trackedResults
        .filter((result) => !result.spilled)
        .sort((left, right) => right.size - left.size)[0]

      if (!candidate) {
        break
      }

      const saved = resultStore.save(candidate.content, candidate.toolName)

      if (!saved) {
        break
      }

      const originalSize = candidate.size
      const preview = candidate.content.slice(0, TURN_BUDGET_PREVIEW_LENGTH)
      const output = `${preview}\n\n[Result spilled to ${saved.path} to stay within the per-turn tool budget.]`
      const previewSize = output.length

      if (previewSize >= originalSize) {
        break
      }

      candidate.content = output
      candidate.size = previewSize
      candidate.spilled = true
      this.totalSize = this.totalSize - originalSize + previewSize
      this.emitObserverEvent({
        type: "budget.spill_largest",
        payload: {
          toolName: candidate.toolName,
          spilledSize: originalSize,
          previewLength: TURN_BUDGET_PREVIEW_LENGTH,
          diskPath: saved.path,
          remainingBudget: Math.max(0, this.maxChars - this.totalSize),
        },
      })
      spills.push({
        position: candidate.position,
        toolName: candidate.toolName,
        path: saved.path,
        output,
        originalSize,
        previewSize,
      })
    }

    return spills
  }

  private emitObserverEvent(event:
    | {
        type: "budget.turn_over_budget"
        payload: {
          turnCumulativeSize: number
          maxChars: number
          trackedToolCount: number
        }
      }
    | {
        type: "budget.spill_largest"
        payload: {
          toolName: string
          spilledSize: number
          previewLength: number
          diskPath: string
          remainingBudget: number
        }
      }) {
    if (!this.observerContext) {
      return
    }

    try {
      this.observer?.recordToolEvent?.({
        ...event,
        sessionId: this.observerContext.sessionId,
        runId: this.observerContext.runId,
      })
    } catch {}
  }
}

export { DEFAULT_TURN_BUDGET_MAX_CHARS, TURN_BUDGET_PREVIEW_LENGTH }
