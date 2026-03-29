import { findOrderedMatches } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalTraceSequenceExpectation } from "../schemas/task"

export type EvalTraceSequenceGrade = {
  pass: boolean
  orderedEventTypes: string[]
  observedEventTypes: string[]
  missingOrderedEventTypes: string[]
}

export function gradeTraceSequenceExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalTraceSequenceExpectation
}): EvalTraceSequenceGrade {
  const observedEventTypes = input.artifact.trace?.events.map((event) => event.eventType) ?? []
  const ordered = findOrderedMatches(observedEventTypes, input.expectation.orderedEventTypes)

  return {
    pass: ordered.pass,
    orderedEventTypes: input.expectation.orderedEventTypes,
    observedEventTypes,
    missingOrderedEventTypes: ordered.missing,
  }
}
