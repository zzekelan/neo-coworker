import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalOutcomeExpectation } from "../schemas/task"

export type EvalOutcomeGrade = {
  pass: boolean
  expectedRunStatus: EvalOutcomeExpectation["runStatus"]
  observedRunStatus: EvalRunArtifact["outcome"]["runStatus"]
  expectedErrorIncludes: string | null
  observedErrorText: string | null
  fileFailures: string[]
}

export function gradeOutcomeExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalOutcomeExpectation
}): EvalOutcomeGrade {
  const fileFailures: string[] = []

  for (const expectedFile of input.expectation.watchedFiles) {
    const observedFile = input.artifact.outcome.watchedFiles.find(
      (file) => file.path === expectedFile.path,
    )

    if (!observedFile) {
      fileFailures.push(`missing watched file result for ${expectedFile.path}`)
      continue
    }

    if (observedFile.exists !== expectedFile.shouldExist) {
      fileFailures.push(
        `${expectedFile.path} expected exists=${expectedFile.shouldExist} but observed ${observedFile.exists}`,
      )
      continue
    }

    if (
      expectedFile.contentIncludes &&
      (!observedFile.content || !observedFile.content.includes(expectedFile.contentIncludes))
    ) {
      fileFailures.push(`${expectedFile.path} did not include expected content`)
    }
  }

  const errorMatched =
    input.expectation.errorIncludes == null ||
    input.artifact.outcome.errorText?.includes(input.expectation.errorIncludes) === true

  return {
    pass:
      input.artifact.outcome.runStatus === input.expectation.runStatus &&
      errorMatched &&
      fileFailures.length === 0,
    expectedRunStatus: input.expectation.runStatus,
    observedRunStatus: input.artifact.outcome.runStatus,
    expectedErrorIncludes: input.expectation.errorIncludes ?? null,
    observedErrorText: input.artifact.outcome.errorText,
    fileFailures,
  }
}
