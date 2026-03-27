import {
  createKnowledgeRuntimeApi,
  type CreateKnowledgeRuntimeApiInput,
  type KnowledgeStoragePort,
} from "../application"
import {
  createKnowledgeRepository,
  type KnowledgeDatabase,
} from "../infrastructure/sqlite"
import { createKnowledgeFileStorage } from "../infrastructure/filesystem"

export * from "../application"
export {
  createKnowledgeFileStorage,
} from "../infrastructure/filesystem"
export {
  createKnowledgeRepository,
  type KnowledgeDatabase,
} from "../infrastructure/sqlite"

export function createKnowledgeStorage(input: {
  database: KnowledgeDatabase
  now?: () => number
  storage?: KnowledgeStoragePort
}) {
  const repository = createKnowledgeRepository({
    database: input.database,
    now: input.now,
  })
  const storage = input.storage ?? createKnowledgeFileStorage()

  return {
    repository,
    runtime: createKnowledgeRuntimeApi({
      repository,
      storage,
      now: input.now,
    } satisfies CreateKnowledgeRuntimeApiInput),
  }
}
