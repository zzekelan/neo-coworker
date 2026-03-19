import {
  createSessionRunService,
  createSessionTranscriptService,
  type CreateSessionRunServiceInput,
} from "../service"

export type SessionRuntimeApiInput = CreateSessionRunServiceInput

export function createSessionRuntimeApi(input: SessionRuntimeApiInput) {
  const runService = createSessionRunService(input)
  const transcriptService = createSessionTranscriptService(input)

  return {
    runs: {
      getSessionState: runService.getSessionState,
      start: runService.startRun,
      retry: runService.retryRun,
      transitionToRunning: runService.transitionRunToRunning,
      resume: runService.resumeRun,
      complete: runService.completeRun,
      fail: runService.failRun,
      cancel: runService.cancelRun,
    },
    transcript: {
      listSessionTranscript: transcriptService.listSessionTranscript,
      getInitiatingMessage: transcriptService.getInitiatingMessage,
    },
  }
}

export type SessionRuntimeApi = ReturnType<typeof createSessionRuntimeApi>
