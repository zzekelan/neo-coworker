import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalToolPolicyExpectation } from "../schemas/task"

export type EvalToolPolicyGrade = {
  pass: boolean
  requiredToolNames: string[]
  forbiddenToolNames: string[]
  observedToolNames: string[]
  missingToolNames: string[]
  unexpectedToolNames: string[]
}

function readObservedToolNames(artifact: EvalRunArtifact) {
  const observed = new Set<string>()

  for (const event of artifact.trace?.events ?? []) {
    const toolName =
      typeof event.data.toolName === "string"
        ? event.data.toolName
        : typeof event.data.name === "string"
          ? event.data.name
          : null

    if (toolName) {
      observed.add(toolName)
    }
  }

  return [...observed]
}

export function gradeToolPolicyExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalToolPolicyExpectation
}): EvalToolPolicyGrade {
  const observedToolNames = readObservedToolNames(input.artifact)
  const missingToolNames = input.expectation.requiredToolNames.filter(
    (toolName) => !observedToolNames.includes(toolName),
  )
  const unexpectedToolNames = input.expectation.forbiddenToolNames.filter((toolName) =>
    observedToolNames.includes(toolName),
  )

  return {
    pass: missingToolNames.length === 0 && unexpectedToolNames.length === 0,
    requiredToolNames: input.expectation.requiredToolNames,
    forbiddenToolNames: input.expectation.forbiddenToolNames,
    observedToolNames,
    missingToolNames,
    unexpectedToolNames,
  }
}
