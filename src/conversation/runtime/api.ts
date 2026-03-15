import {
  createConversationRunService,
  createConversationTranscriptService,
  type CreateConversationRunServiceInput,
} from "../service"

export type ConversationRuntimeApiInput = CreateConversationRunServiceInput

export function createConversationRuntimeApi(input: ConversationRuntimeApiInput) {
  const runService = createConversationRunService(input)
  const transcriptService = createConversationTranscriptService(input)

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

export type ConversationRuntimeApi = ReturnType<typeof createConversationRuntimeApi>
