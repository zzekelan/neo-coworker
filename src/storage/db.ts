import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { CURRENT_STORAGE_SCHEMA_VERSION, STORAGE_MIGRATIONS } from "./schema"

export type StorageDatabase = Database

export function openStorageDatabase(filePath: string) {
  ensureParentDirectory(filePath)

  const database = new Database(filePath, { create: true, strict: true })

  try {
    configureDatabase(database)
    runStorageMigrations(database)
    return database
  } catch (error) {
    database.close(false)
    throw wrapStorageSetupError(filePath, error)
  }
}

function ensureParentDirectory(filePath: string) {
  const parentDirectory = dirname(filePath)
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true })
  }
}

function configureDatabase(database: Database) {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA journal_mode = WAL")
}

function runStorageMigrations(database: Database) {
  const versionRow = database
    .query("PRAGMA user_version")
    .get() as { user_version: number } | null
  const currentVersion = versionRow?.user_version ?? 0

  if (currentVersion > CURRENT_STORAGE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${CURRENT_STORAGE_SCHEMA_VERSION}`,
    )
  }

  for (const migration of STORAGE_MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue
    }

    const applyMigration = database.transaction((statements: readonly string[], version: number) => {
      for (const statement of statements) {
        database.exec(statement)
      }
      database.exec(`PRAGMA user_version = ${version}`)
    })

    applyMigration(migration.statements, migration.version)
  }
}

function wrapStorageSetupError(filePath: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"
  return new Error(`Failed to initialize storage at ${filePath}: ${message}`)
}
