import { readPromptAssemblyEvents } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalPromptAssemblyExpectation } from "../schemas/task"

export type EvalPromptAssemblyGrade = {
  pass: boolean
  failures: string[]
  observedPromptCount: number
}

export function gradePromptAssemblyExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalPromptAssemblyExpectation
}): EvalPromptAssemblyGrade {
  const promptEvents = readPromptAssemblyEvents(input.artifact)
  const failures: string[] = []

  for (const checkpoint of input.expectation.checkpoints) {
    const promptEvent = promptEvents[checkpoint.promptIndex]

    if (!promptEvent) {
      failures.push(`missing prompt assembly event ${checkpoint.promptIndex}`)
      continue
    }

    for (const skillName of checkpoint.catalogSkillNamesIncludes) {
      if (!promptEvent.catalogSkillNames.includes(skillName)) {
        failures.push(`prompt ${checkpoint.promptIndex} missing catalog skill ${skillName}`)
      }
    }

    for (const skillName of checkpoint.activeSkillNamesIncludes) {
      if (!promptEvent.activeSkillNames.includes(skillName)) {
        failures.push(`prompt ${checkpoint.promptIndex} missing active skill ${skillName}`)
      }
    }

    for (const skillName of checkpoint.activeSkillNamesExcludes) {
      if (promptEvent.activeSkillNames.includes(skillName)) {
        failures.push(`prompt ${checkpoint.promptIndex} unexpectedly included active skill ${skillName}`)
      }
    }

    if (
      checkpoint.activeSkillCount !== undefined &&
      promptEvent.activeSkillCount !== checkpoint.activeSkillCount
    ) {
      failures.push(
        `prompt ${checkpoint.promptIndex} expected active skill count ${checkpoint.activeSkillCount} but observed ${promptEvent.activeSkillCount ?? "null"}`,
      )
    }
  }

  if (input.expectation.requireStableSystemPromptHash) {
    const distinctHashes = new Set(
      promptEvents
        .map((event) => event.systemPromptHash)
        .filter((hash): hash is string => typeof hash === "string" && hash.length > 0),
    )

    if (distinctHashes.size > 1) {
      failures.push("prompt assembly changed the supposedly static system prompt hash")
    }
  }

  if (input.expectation.requireDistinctSystemReminderHashes) {
    const distinctHashes = new Set(
      promptEvents
        .map((event) => event.systemReminderHash)
        .filter((hash): hash is string => typeof hash === "string" && hash.length > 0),
    )

    if (distinctHashes.size < 2) {
      failures.push("prompt assembly never produced distinct system reminder hashes")
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    observedPromptCount: promptEvents.length,
  }
}
