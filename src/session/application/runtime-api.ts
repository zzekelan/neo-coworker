import {
  createSessionRunService,
  type CreateSessionRunServiceInput,
} from "./run-service"
import { createSessionTimelineService } from "./timeline-service"

export type SessionRuntimeApiInput = CreateSessionRunServiceInput

export function createSessionRuntimeApi(input: SessionRuntimeApiInput) {
  const runService = createSessionRunService(input)
  const timelineService = createSessionTimelineService(input)

  return {
    sessions: {
      getCurrentAgent: runService.getSessionCurrentAgent,
      setCurrentAgent: runService.setSessionCurrentAgent,
    },
    runs: {
      getSessionState: runService.getSessionState,
      start: runService.startRun,
      startCommand: runService.startCommandRun,
      retry: runService.retryRun,
      transitionToRunning: runService.transitionRunToRunning,
      resume: runService.resumeRun,
      complete: runService.completeRun,
      fail: runService.failRun,
      cancel: runService.cancelRun,
      addActiveSkills: runService.addRunActiveSkills,
      recordTokenUsage: runService.recordRunTokenUsage,
    },
    timeline: {
      listSessionTimeline: timelineService.listSessionTimeline,
      getInitiatingMessage: timelineService.getInitiatingMessage,
    },
  }
}

export type SessionRuntimeApi = ReturnType<typeof createSessionRuntimeApi>
export type SessionProvider = SessionRuntimeApi
