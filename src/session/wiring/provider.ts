import {
  createSessionRepository,
  openSessionDatabase,
  type SessionDatabase,
} from "../repo"
import type { SessionTelemetryPort } from "../ports/telemetry"
import { createSessionRuntimeApi } from "../runtime/api"
import type { SessionRuntimeApi } from "../runtime/api"

export type SessionProvider = SessionRuntimeApi

export function createSessionProvider(input: {
  runtime: SessionRuntimeApi
  telemetry?: SessionTelemetryPort
}) {
  input.telemetry?.recordSessionEvent?.("session.provider.created")
  return input.runtime
}

export function openSessionStorage(path: string) {
  return openSessionDatabase(path)
}

export function createSessionStorage(input: {
  database: SessionDatabase
  now?: () => number
}) {
  const repository = createSessionRepository({
    database: input.database,
    now: input.now,
  })
  const runtime = createSessionRuntimeApi({
    repository,
    now: input.now,
  })

  return {
    repository,
    runtime: createSessionProvider({
      runtime,
    }),
  }
}
