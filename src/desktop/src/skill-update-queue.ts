export type SkillUpdateQueue = ReturnType<typeof createSkillUpdateQueue>

export function createSkillUpdateQueue(input: {
  submit(skills: string[]): Promise<void>
  onOptimisticChange(skills: string[] | null): void
  onError(error: unknown): void
}) {
  let desiredSkills: string[] | null = null
  let generation = 0
  let activeFlushPromise: Promise<void> | null = null

  function startFlush(queueGeneration: number) {
    if (activeFlushPromise) {
      return activeFlushPromise
    }

    if (!desiredSkills) {
      return Promise.resolve()
    }

    activeFlushPromise = (async () => {
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
        throw error
      } finally {
        activeFlushPromise = null

        if (queueGeneration === generation && desiredSkills) {
          void startFlush(queueGeneration).catch(() => {})
        }
      }
    })()

    return activeFlushPromise
  }

  async function flush() {
    const queueGeneration = generation

    while (queueGeneration === generation) {
      if (desiredSkills) {
        await startFlush(queueGeneration)
        continue
      }

      if (activeFlushPromise) {
        await activeFlushPromise
        continue
      }

      return
    }
  }

  return {
    enqueue(skills: string[]) {
      desiredSkills = [...skills]
      input.onOptimisticChange([...skills])
      void startFlush(generation).catch(() => {})
    },
    flush,
    isPending() {
      return desiredSkills !== null || activeFlushPromise !== null
    },
    reset() {
      generation += 1
      desiredSkills = null
      activeFlushPromise = null
      input.onOptimisticChange(null)
    },
  }
}
