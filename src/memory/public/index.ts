import { createMemoryService, type CreateMemoryServiceInput, type MemoryStore } from "../application/memory-service"
import { createMarkdownMemoryRepository } from "../infrastructure/markdown"

export * from "../application/memory-service"
export { createMarkdownMemoryRepository, getMemoryFilePath } from "../infrastructure/markdown"

export function createMemoryRuntime(
  basePath: string,
  input: Omit<CreateMemoryServiceInput, "repository"> & { runtime?: MemoryStore } = {},
) {
  return (
    input.runtime ??
    createMemoryService({
      ...input,
      repository: createMarkdownMemoryRepository(basePath),
    })
  )
}
