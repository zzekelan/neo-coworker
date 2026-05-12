import { findOrderedMatches, readTimelineContentViews } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalTimelineExpectation } from "../schemas/task"

export type EvalTimelineGrade = {
  pass: boolean
  orderedTextIncludes: string[]
  observedTexts: string[]
  missingOrderedTexts: string[]
  checkpointFailures: string[]
}

export function gradeTimelineExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalTimelineExpectation
}): EvalTimelineGrade {
  const messages = readTimelineContentViews(input.artifact)
  const observedTexts = messages.flatMap((message) => message.texts)
  const ordered = findOrderedMatches(observedTexts, input.expectation.orderedTextIncludes)
  const checkpointFailures: string[] = []

  for (const checkpoint of input.expectation.checkpoints) {
    const message = messages[checkpoint.messageIndex]

    if (!message) {
      checkpointFailures.push(`missing timeline entry ${checkpoint.messageIndex}`)
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

    const toolCallCount = message.partKinds.filter((kind) => kind === "tool_call").length
    const toolResultCount = message.partKinds.filter((kind) => kind === "tool_result").length

    if (checkpoint.toolCallCount !== undefined && toolCallCount !== checkpoint.toolCallCount) {
      checkpointFailures.push(
        `message ${checkpoint.messageIndex} expected ${checkpoint.toolCallCount} tool calls but observed ${toolCallCount}`,
      )
    }

    if (checkpoint.toolResultCount !== undefined && toolResultCount !== checkpoint.toolResultCount) {
      checkpointFailures.push(
        `message ${checkpoint.messageIndex} expected ${checkpoint.toolResultCount} tool results but observed ${toolResultCount}`,
      )
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
