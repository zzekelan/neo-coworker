export type SkillUpdateQueue = ReturnType<typeof createSkillUpdateQueue>

export function createSkillUpdateQueue(input: {
  submit(skills: string[]): Promise<void>
  onOptimisticChange(skills: string[] | null): void
  onError(error: unknown): void
}) {
  let desiredSkills: string[] | null = null
  let isFlushing = false
  let generation = 0

  async function flush(queueGeneration: number) {
    if (isFlushing) {
      return
    }

    isFlushing = true

    try {
      while (queueGeneration === generation && desiredSkills) {
        const nextSkills = desiredSkills
        desiredSkills = null
        await input.submit(nextSkills)

        if (queueGeneration !== generation) {
          return
        }

        if (desiredSkills === null) {
          input.onOptimisticChange(null)
        }
      }
    } catch (error) {
      if (queueGeneration === generation) {
        desiredSkills = null
        input.onOptimisticChange(null)
        input.onError(error)
      }
    } finally {
      isFlushing = false

      if (queueGeneration === generation && desiredSkills) {
        void flush(queueGeneration)
      }
    }
  }

  return {
    enqueue(skills: string[]) {
      desiredSkills = [...skills]
      input.onOptimisticChange([...skills])
      void flush(generation)
    },
    reset() {
      generation += 1
      desiredSkills = null
      input.onOptimisticChange(null)
    },
  }
}
