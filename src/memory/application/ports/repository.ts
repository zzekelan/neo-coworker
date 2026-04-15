export type MemoryRepository = {
  load(target: "agent" | "user"): Promise<
    Array<{
      target: "agent" | "user"
      content: string
      metadata?: Record<string, string>
    }>
  >
  save(
    target: "agent" | "user",
    entries: Array<{
      target: "agent" | "user"
      content: string
      metadata?: Record<string, string>
    }>,
  ): Promise<void>
}
