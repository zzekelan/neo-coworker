import type { OrchestrationActiveRunState } from "../service"

type ActiveRunKey = Pick<
  OrchestrationActiveRunState,
  "storageIdentity" | "sessionId" | "runId"
>

function getActiveRunKey(input: ActiveRunKey) {
  return `${input.storageIdentity}:${input.sessionId}:${input.runId}`
}

export function createActiveRunRegistry() {
  const activeRuns = new Map<string, OrchestrationActiveRunState>()

  return {
    has(input: ActiveRunKey) {
      return activeRuns.has(getActiveRunKey(input))
    },
    get(input: ActiveRunKey) {
      return activeRuns.get(getActiveRunKey(input))
    },
    add(activeRun: OrchestrationActiveRunState) {
      activeRuns.set(getActiveRunKey(activeRun), activeRun)
    },
    delete(input: ActiveRunKey) {
      activeRuns.delete(getActiveRunKey(input))
    },
  }
}
