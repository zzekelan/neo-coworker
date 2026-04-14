export type Checkpoint = {
  id: string
  timestamp: Date
  description: string
  stashRef: string
}

export interface CheckpointStore {
  create(workDir: string, description: string): Promise<Checkpoint>
  restore(workDir: string, checkpointId: string): Promise<void>
  list(workDir: string): Promise<Checkpoint[]>
  prune(workDir: string, keepLast: number): Promise<number>
}

export const CHECKPOINT_TRIGGERS = ["write", "edit", "patch", "shell"] as const

const SHELL_MUTATION_PATTERNS = [
  /(?:^|\s|&&|\|\||;|`)(?:rm\s|rmdir\s|mv\s|cp\s|mkdir\s|touch\s|truncate\s|dd\s|shred\s|install\s|ln\s)/,
  /(?:^|\s|&&|\|\||;|`)(?:sed\s+-i|perl\s+-pi)\b/,
  /(?:^|\s|&&|\|\||;|`)git\s+(?:reset|clean|checkout|restore|apply|stash)\b/,
] as const

const SHELL_OVERWRITE_REDIRECT = /(^|[^>])>(?!>)/

export function shouldCheckpoint(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "write" || toolName === "edit" || toolName === "patch") {
    return true
  }

  if (toolName !== "shell") {
    return false
  }

  const command = typeof args.command === "string" ? args.command.trim() : ""
  if (command.length === 0) {
    return false
  }

  return (
    SHELL_MUTATION_PATTERNS.some((pattern) => pattern.test(command)) ||
    SHELL_OVERWRITE_REDIRECT.test(command)
  )
}
