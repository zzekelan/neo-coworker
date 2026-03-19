export type ActiveRunKey = {
  storageIdentity: string
  sessionId: string
  runId: string
}

export type ActiveRunRecord<Suspend, Emit> = ActiveRunKey & {
  controller: AbortController
  suspend: Suspend
  emit: Emit
}

export type ActiveRunRegistry<Suspend, Emit> = {
  has(input: ActiveRunKey): boolean
  get(input: ActiveRunKey): ActiveRunRecord<Suspend, Emit> | undefined
  add(activeRun: ActiveRunRecord<Suspend, Emit>): void
  delete(input: ActiveRunKey): void
}

function getActiveRunKey(input: ActiveRunKey) {
  return `${input.storageIdentity}:${input.sessionId}:${input.runId}`
}

export function createInMemoryActiveRunRegistry<Suspend, Emit>(): ActiveRunRegistry<
  Suspend,
  Emit
> {
  const activeRuns = new Map<string, ActiveRunRecord<Suspend, Emit>>()

  return {
    has(input) {
      return activeRuns.has(getActiveRunKey(input))
    },
    get(input) {
      return activeRuns.get(getActiveRunKey(input))
    },
    add(activeRun) {
      activeRuns.set(getActiveRunKey(activeRun), activeRun)
    },
    delete(input) {
      activeRuns.delete(getActiveRunKey(input))
    },
  }
}
