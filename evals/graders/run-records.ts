import { readArtifactRuns } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalRunRecordsExpectation } from "../schemas/task"

export type EvalRunRecordsGrade = {
  pass: boolean
  failures: string[]
}

export function gradeRunRecordsExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalRunRecordsExpectation
}): EvalRunRecordsGrade {
  const runs = readArtifactRuns(input.artifact)
  const failures: string[] = []

  for (const checkpoint of input.expectation.checkpoints) {
    const run = runs[checkpoint.runIndex]

    if (!run) {
      failures.push(`missing run ${checkpoint.runIndex}`)
      continue
    }

    if (checkpoint.trigger && run.trigger !== checkpoint.trigger) {
      failures.push(
        `run ${checkpoint.runIndex} expected trigger ${checkpoint.trigger} but observed ${run.trigger}`,
      )
    }

    if (checkpoint.status && run.status !== checkpoint.status) {
      failures.push(
        `run ${checkpoint.runIndex} expected status ${checkpoint.status} but observed ${run.status}`,
      )
    }

    if (checkpoint.minInputTokens !== undefined && run.inputTokens < checkpoint.minInputTokens) {
      failures.push(
        `run ${checkpoint.runIndex} expected input tokens >= ${checkpoint.minInputTokens} but observed ${run.inputTokens}`,
      )
    }

    if (checkpoint.minOutputTokens !== undefined && run.outputTokens < checkpoint.minOutputTokens) {
      failures.push(
        `run ${checkpoint.runIndex} expected output tokens >= ${checkpoint.minOutputTokens} but observed ${run.outputTokens}`,
      )
    }

    if (
      checkpoint.tokenUsageSources.length > 0 &&
      (!run.tokenUsageSource || !checkpoint.tokenUsageSources.includes(run.tokenUsageSource))
    ) {
      failures.push(
        `run ${checkpoint.runIndex} expected token usage source in ${checkpoint.tokenUsageSources.join(", ")} but observed ${run.tokenUsageSource ?? "null"}`,
      )
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  }
}
