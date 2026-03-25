import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalProtocolExpectation } from "../schemas/task"

export type EvalProtocolGrade = {
  pass: boolean
  requiredRuntimeEventTypes: string[]
  forbiddenRuntimeEventTypes: string[]
  observedRuntimeEventTypes: string[]
  missingRuntimeEventTypes: string[]
  unexpectedRuntimeEventTypes: string[]
}

export function gradeProtocolExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalProtocolExpectation
}): EvalProtocolGrade {
  const observedRuntimeEventTypes = input.artifact.runtimeEvents.map((event) => event.type)
  const missingRuntimeEventTypes = input.expectation.requiredRuntimeEventTypes.filter(
    (eventType) => !observedRuntimeEventTypes.includes(eventType),
  )
  const unexpectedRuntimeEventTypes = input.expectation.forbiddenRuntimeEventTypes.filter(
    (eventType) => observedRuntimeEventTypes.includes(eventType),
  )

  return {
    pass: missingRuntimeEventTypes.length === 0 && unexpectedRuntimeEventTypes.length === 0,
    requiredRuntimeEventTypes: input.expectation.requiredRuntimeEventTypes,
    forbiddenRuntimeEventTypes: input.expectation.forbiddenRuntimeEventTypes,
    observedRuntimeEventTypes,
    missingRuntimeEventTypes,
    unexpectedRuntimeEventTypes,
  }
}
