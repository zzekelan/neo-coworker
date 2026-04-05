import {
  createSessionRunService,
  type CreateSessionRunServiceInput,
} from "./run-service"
import { createSessionTranscriptService } from "./transcript-service"

export type SessionRuntimeApiInput = CreateSessionRunServiceInput

export function createSessionRuntimeApi(input: SessionRuntimeApiInput) {
  const runService = createSessionRunService(input)
  const transcriptService = createSessionTranscriptService(input)

  return {
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
      updateActiveSkills: runService.updateRunActiveSkills,
      recordTokenUsage: runService.recordRunTokenUsage,
    },
    transcript: {
      listSessionTranscript: transcriptService.listSessionTranscript,
      getInitiatingMessage: transcriptService.getInitiatingMessage,
    },
  }
}

export type SessionRuntimeApi = ReturnType<typeof createSessionRuntimeApi>
export type SessionProvider = SessionRuntimeApi
