import { findOrderedMatches, readTranscriptViews } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalTranscriptExpectation } from "../schemas/task"

export type EvalTranscriptGrade = {
  pass: boolean
  orderedTextIncludes: string[]
  observedTexts: string[]
  missingOrderedTexts: string[]
  checkpointFailures: string[]
}

export function gradeTranscriptExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalTranscriptExpectation
}): EvalTranscriptGrade {
  const messages = readTranscriptViews(input.artifact)
  const observedTexts = messages.flatMap((message) => message.texts)
  const ordered = findOrderedMatches(observedTexts, input.expectation.orderedTextIncludes)
  const checkpointFailures: string[] = []

  for (const checkpoint of input.expectation.checkpoints) {
    const message = messages[checkpoint.messageIndex]

    if (!message) {
      checkpointFailures.push(`missing transcript message ${checkpoint.messageIndex}`)
      continue
    }

    if (checkpoint.role && message.role !== checkpoint.role) {
      checkpointFailures.push(
        `message ${checkpoint.messageIndex} expected role ${checkpoint.role} but observed ${message.role ?? "null"}`,
      )
    }

    for (const partKind of checkpoint.partKinds) {
      if (!message.partKinds.includes(partKind)) {
        checkpointFailures.push(`message ${checkpoint.messageIndex} missing part kind ${partKind}`)
      }
    }

    for (const text of checkpoint.textIncludes) {
      if (!message.combinedText.includes(text)) {
        checkpointFailures.push(`message ${checkpoint.messageIndex} missing text ${JSON.stringify(text)}`)
      }
    }

    for (const toolName of checkpoint.toolNames) {
      if (!message.toolNames.includes(toolName)) {
        checkpointFailures.push(`message ${checkpoint.messageIndex} missing tool ${toolName}`)
      }
    }
  }

  return {
    pass: ordered.pass && checkpointFailures.length === 0,
    orderedTextIncludes: input.expectation.orderedTextIncludes,
    observedTexts,
    missingOrderedTexts: ordered.missing,
    checkpointFailures,
  }
}
