import { readPromptAssemblyEvents } from "./artifact-views"
import type { EvalRunArtifact } from "../schemas/artifact"
import type { EvalSkillDisclosureExpectation } from "../schemas/task"

export type EvalSkillDisclosureGrade = {
  pass: boolean
  failures: string[]
}

export function gradeSkillDisclosureExpectation(input: {
  artifact: EvalRunArtifact
  expectation: EvalSkillDisclosureExpectation | undefined
}): EvalSkillDisclosureGrade {
  if (!input.expectation) {
    return {
      pass: true,
      failures: [],
    }
  }

  const skillName = input.expectation.skillName
  const traceEvents = input.artifact.trace?.events ?? []
  const promptEvents = readPromptAssemblyEvents(input.artifact)
  const failures: string[] = []
  const activationEvent = traceEvents.find(
    (event) => event.eventType === "skill.activated" && event.data.skillName === skillName,
  )

  if (input.expectation.requireCatalogExposure) {
    const catalogExposed = traceEvents.some(
      (event) =>
        event.eventType === "skill.catalog.exposed" &&
        Array.isArray(event.data.catalogSkillNames) &&
        event.data.catalogSkillNames.includes(skillName),
    )

    if (!catalogExposed) {
      failures.push(`catalog exposure missing ${skillName}`)
    }
  }

  if (input.expectation.requireLoadEvents) {
    const sawLoadRequested = traceEvents.some(
      (event) =>
        event.eventType === "skill.load.requested" && event.data.skillName === skillName,
    )
    const sawLoadCompleted = traceEvents.some(
      (event) =>
        event.eventType === "skill.load.completed" && event.data.skillName === skillName,
    )

    if (!sawLoadRequested) {
      failures.push(`skill.load.requested missing ${skillName}`)
    }

    if (!sawLoadCompleted) {
      failures.push(`skill.load.completed missing ${skillName}`)
    }
  }

  if (input.expectation.requireActivationEvent && !activationEvent) {
    failures.push(`skill.activated missing ${skillName}`)
  }

  if (activationEvent) {
    const beforePrompts = promptEvents.filter((event) => event.sequence < activationEvent.sequence)
    const afterPrompts = promptEvents.filter((event) => event.sequence > activationEvent.sequence)

    if (
      input.expectation.requireAbsentBeforeActivation &&
      beforePrompts.some((event) => event.activeSkillNames.includes(skillName))
    ) {
      failures.push(`${skillName} appeared in prompt assembly before activation`)
    }

    if (
      input.expectation.requirePresentAfterActivation &&
      !afterPrompts.some((event) => event.activeSkillNames.includes(skillName))
    ) {
      failures.push(`${skillName} never appeared in prompt assembly after activation`)
    }

    if (input.expectation.requirePromptChange) {
      const lastBefore = beforePrompts.at(-1)
      const firstAfter = afterPrompts[0]

      if (!lastBefore || !firstAfter) {
        failures.push(`missing prompt assembly checkpoints around activation for ${skillName}`)
      } else if (lastBefore.systemReminderHash === firstAfter.systemReminderHash) {
        failures.push(`${skillName} did not change the system reminder payload`)
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures,
  }
}
