import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalTraceExpectation } from "../schemas/task"

export type EvalTraceGrade = {
  pass: boolean
  requiredEventTypes: string[]
  observedEventTypes: string[]
  missingEventTypes: string[]
}

export function gradeTraceExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalTraceExpectation
}): EvalTraceGrade {
  const observedEventTypes = input.artifact.trace?.events.map((event) => event.eventType) ?? []
  const missingEventTypes = input.expectation.requiredEventTypes.filter(
    (eventType) => !observedEventTypes.includes(eventType),
  )

  return {
    pass: missingEventTypes.length === 0,
    requiredEventTypes: input.expectation.requiredEventTypes,
    observedEventTypes,
    missingEventTypes,
  }
}
