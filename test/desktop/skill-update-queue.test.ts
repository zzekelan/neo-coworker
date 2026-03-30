import { describe, expect, test } from "bun:test"
import { createSkillUpdateQueue } from "../../src/desktop/src/skill-update-queue"

describe("desktop skill update queue", () => {
  test("serializes rapid skill changes without dropping earlier optimistic state", async () => {
    const optimisticSnapshots: Array<string[] | null> = []
    const submittedSkills: string[][] = []
    const errors: unknown[] = []
    const firstSubmission = createDeferred()
    const secondSubmission = createDeferred()
    const submissions = [firstSubmission, secondSubmission]
    let submissionIndex = 0

    const queue = createSkillUpdateQueue({
      submit(skills) {
        submittedSkills.push([...skills])
        return submissions[submissionIndex++]!.promise
      },
      onOptimisticChange(skills) {
        optimisticSnapshots.push(skills ? [...skills] : null)
      },
      onError(error) {
        errors.push(error)
      },
    })

    queue.enqueue(["writer"])
    queue.enqueue(["writer", "reviewer"])

    expect(submittedSkills).toEqual([["writer"]])
    expect(optimisticSnapshots).toEqual([["writer"], ["writer", "reviewer"]])

    firstSubmission.resolve()
    await flushMicrotasks()

    expect(submittedSkills).toEqual([["writer"], ["writer", "reviewer"]])

    secondSubmission.resolve()
    await flushMicrotasks()

    expect(optimisticSnapshots).toEqual([["writer"], ["writer", "reviewer"], null])
    expect(errors).toEqual([])
  })
})

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })

  return {
    promise,
    resolve,
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}
