import type { RuntimeEvent } from "../../application/event"
import type { OrchestrationRunSuspension } from "./run-suspension"

export type OrchestrationActiveRunKey = {
  storageIdentity: string
  sessionId: string
  runId: string
}

export type OrchestrationActiveRunRecord = OrchestrationActiveRunKey & {
  controller: AbortController
  suspend: OrchestrationRunSuspension
  emit: (event: RuntimeEvent) => void
}

export type OrchestrationActiveRunRegistry = {
  has(input: OrchestrationActiveRunKey): boolean
  get(input: OrchestrationActiveRunKey): OrchestrationActiveRunRecord | undefined
  add(activeRun: OrchestrationActiveRunRecord): void
  delete(input: OrchestrationActiveRunKey): void
}

function getActiveRunKey(input: OrchestrationActiveRunKey) {
  return `${input.storageIdentity}:${input.sessionId}:${input.runId}`
}

export function createInMemoryActiveRunRegistry(): OrchestrationActiveRunRegistry {
  const activeRuns = new Map<string, OrchestrationActiveRunRecord>()

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

export function createOrchestrationActiveRunRegistry(): OrchestrationActiveRunRegistry {
  return createInMemoryActiveRunRegistry()
}
