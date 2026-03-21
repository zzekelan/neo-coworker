import type { Database } from "bun:sqlite"

import type { SessionRepository } from "./ports/repository"

export type SessionDatabase = Database
export type SessionEntityIdPrefix = "session" | "run" | "message" | "part"

export type CreateSessionRepositoryInput = {
  database: SessionDatabase
  now?: () => number
  createId?: (prefix: SessionEntityIdPrefix) => string
}

export type SessionStorageApi = {
  getSessionDatabaseIdentity(database: SessionDatabase): string
  openSessionDatabase(filePath: string): SessionDatabase
  createSessionRepository(input: CreateSessionRepositoryInput): SessionRepository
}

let sessionStorageApi: SessionStorageApi | null = null

export function registerSessionStorageApi(api: SessionStorageApi) {
  sessionStorageApi = api
}

function requireSessionStorageApi() {
  if (sessionStorageApi) {
    return sessionStorageApi
  }

  throw new Error("Session storage infrastructure is not initialized")
}

export function getSessionDatabaseIdentity(database: SessionDatabase) {
  return requireSessionStorageApi().getSessionDatabaseIdentity(database)
}

export function openSessionDatabase(filePath: string) {
  return requireSessionStorageApi().openSessionDatabase(filePath)
}

export function createSessionRepository(input: CreateSessionRepositoryInput) {
  return requireSessionStorageApi().createSessionRepository(input)
}
