import type { PermissionMode } from "./decision"

export type PermissionPolicy = Partial<Record<string, PermissionMode>>
