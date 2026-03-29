import { readTranscriptViews } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalToolConsumptionExpectation } from "../schemas/task"

export type EvalToolConsumptionGrade = {
  pass: boolean
  failures: string[]
}

export function gradeToolConsumptionExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalToolConsumptionExpectation
}): EvalToolConsumptionGrade {
  const messages = readTranscriptViews(input.artifact)
  const failures: string[] = []

  for (const rule of input.expectation.requiredConsumptions) {
    const toolResultIndex = messages.findIndex((message) =>
      message.toolResults.some((toolResult) => {
        if (toolResult.toolName !== rule.toolName) {
          return false
        }

        return rule.toolResultIncludes.every((text) => toolResult.output.includes(text))
      }),
    )

    if (toolResultIndex === -1) {
      failures.push(`missing tool result consumption source for ${rule.toolName}`)
      continue
    }

    const assistantConsumer = messages
      .slice(toolResultIndex + 1)
      .find(
        (message) =>
          message.role === "assistant" &&
          rule.assistantTextIncludes.every((text) => message.combinedText.includes(text)),
      )

    if (!assistantConsumer) {
      failures.push(`missing assistant follow-up that consumes ${rule.toolName}`)
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  }
}
