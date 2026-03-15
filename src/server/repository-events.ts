import type {
  ConversationRepository as StorageRepository,
  StoredRun,
} from "../conversation/repo"
import { buildSessionSnapshot, type ServerEventPayload, type createServerEventBus } from "./events"

type ServerEventBus = ReturnType<typeof createServerEventBus>

export function createObservedRepository(input: {
  repository: StorageRepository
  events: ServerEventBus
}) {
  const repository = input.repository
  const events = input.events

  function publishSessionUpdated(sessionId: string, reason: string) {
    events.publish({
      type: "session.updated",
      ...buildSessionSnapshot(repository, sessionId),
      reason,
    })
  }

  function publishRunCreated(run: StoredRun) {
    events.publish({
      type: "run.created",
      run,
    })
    publishSessionUpdated(run.sessionId, "run.created")
  }

  function publishRunUpdated(run: StoredRun) {
    events.publish({
      type: "run.updated",
      run,
    })
    publishSessionUpdated(run.sessionId, "run.updated")

    if (run.status === "failed" && run.errorText) {
      events.publish({
        type: "runtime.error",
        sessionId: run.sessionId,
        runId: run.id,
        error: run.errorText,
      })
    }
  }

  const observed: StorageRepository = {
    ...repository,
    sessions: {
      ...repository.sessions,
      create(session) {
        const created = repository.sessions.create(session)
        events.publish({
          type: "session.created",
          ...buildSessionSnapshot(repository, created.id),
        })
        return created
      },
    },
    runs: {
      ...repository.runs,
      create(run) {
        const created = repository.runs.create(run)
        publishRunCreated(created)
        return created
      },
      updateStatus(update) {
        const updated = repository.runs.updateStatus(update)
        publishRunUpdated(updated)
        return updated
      },
    },
    messages: {
      ...repository.messages,
      create(message) {
        const created = repository.messages.create(message)
        events.publish({
          type: "message.created",
          message: created,
        })
        return created
      },
    },
    parts: {
      ...repository.parts,
      create(part) {
        const created = repository.parts.create(part)
        events.publish({
          type: "message.part.updated",
          part: created,
        })
        return created
      },
      updateContent(update) {
        const updated = repository.parts.updateContent(update)
        events.publish({
          type: "message.part.updated",
          part: updated,
        })
        return updated
      },
    },
    permissionRequests: {
      ...repository.permissionRequests,
      create(request) {
        const created = repository.permissionRequests.create(request)
        events.publish({
          type: "permission.requested",
          permissionRequest: created,
        })
        publishSessionUpdated(created.sessionId, "permission.requested")
        return created
      },
      updateStatus(update) {
        const updated = repository.permissionRequests.updateStatus(update)
        events.publish({
          type: "permission.updated",
          permissionRequest: updated,
        })
        publishSessionUpdated(updated.sessionId, "permission.updated")
        return updated
      },
    },
    createQueuedRunWithInitiatingMessage(inputValue) {
      const created = repository.createQueuedRunWithInitiatingMessage(inputValue)
      publishRunCreated(created.run)
      events.publish({
        type: "message.created",
        message: created.message,
      })
      return created
    },
    createAssistantMessageWithFirstPart(inputValue) {
      const created = repository.createAssistantMessageWithFirstPart(inputValue)
      events.publish({
        type: "message.created",
        message: created.message,
      })
      events.publish({
        type: "message.part.updated",
        part: created.part,
      })
      return created
    },
    requestPermissionAndPauseRun(inputValue) {
      const created = repository.requestPermissionAndPauseRun(inputValue)
      publishRunUpdated(created.run)
      events.publish({
        type: "permission.requested",
        permissionRequest: created.permissionRequest,
      })
      return created
    },
    cancelRunAndPendingPermissions(inputValue) {
      const cancelled = repository.cancelRunAndPendingPermissions(inputValue)
      publishRunUpdated(cancelled.run)

      for (const permissionRequest of cancelled.permissionRequests) {
        events.publish({
          type: "permission.updated",
          permissionRequest,
        })
      }

      return cancelled
    },
  }

  return observed
}
