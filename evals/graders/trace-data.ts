import { readRunTraceEvents } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalTraceDataExpectation } from "../schemas/task"

export type EvalTraceDataGrade = {
  pass: boolean
  failures: string[]
}

export function gradeTraceDataExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalTraceDataExpectation
}): EvalTraceDataGrade {
  const failures: string[] = []

  for (const eventExpectation of input.expectation.events) {
    const events = readRunTraceEvents(input.artifact, eventExpectation.runIndex)
    const matchedEvent = events.find(
      (event) =>
        event.eventType === eventExpectation.eventType &&
        eventExpectation.fields.every((fieldExpectation) =>
          matchesFieldExpectation(event.data[fieldExpectation.field], fieldExpectation),
        ),
    )

    if (!matchedEvent) {
      failures.push(
        `missing trace event ${eventExpectation.eventType} matching payload expectation on run ${eventExpectation.runIndex ?? "final"}`,
      )
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  }
}

function matchesFieldExpectation(
  value: unknown,
  expectation: EvalTraceDataExpectation["events"][number]["fields"][number],
) {
  if (expectation.valueType) {
    if (expectation.valueType === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return false
      }
    } else if (typeof value !== expectation.valueType) {
      return false
    }
  }

  if (expectation.equalsString !== undefined && value !== expectation.equalsString) {
    return false
  }

  if (expectation.equalsNumber !== undefined && value !== expectation.equalsNumber) {
    return false
  }

  if (expectation.equalsBoolean !== undefined && value !== expectation.equalsBoolean) {
    return false
  }

  if (expectation.greaterThanNumber !== undefined) {
    if (typeof value !== "number" || !(value > expectation.greaterThanNumber)) {
      return false
    }
  }

  if (expectation.lessThanNumber !== undefined) {
    if (typeof value !== "number" || !(value < expectation.lessThanNumber)) {
      return false
    }
  }

  if (expectation.includes !== undefined) {
    if (typeof value !== "string" || !value.includes(expectation.includes)) {
      return false
    }
  }

  return true
}
