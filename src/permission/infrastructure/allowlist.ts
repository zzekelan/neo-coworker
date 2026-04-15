// @ts-expect-error Bun runtime module is provided by Bun.
import { Database } from "bun:sqlite"
import { isAbsolute, relative, resolve } from "node:path"

import { observePermissionEvent } from "../application/observe"
import type { PermissionObserverPort } from "../application/ports/permission-observer"

const WORKSPACE_SCOPE = "workspace" as const
const PATH_GLOB_TOOLS = new Set(["write", "edit"])

type AllowlistRow = {
  workspace_root: string
  tool_name: string
  pattern: string
  reason: string | null
  created_at: number
}

export type AllowlistScope = typeof WORKSPACE_SCOPE

export type AllowlistEntry = {
  toolName: string
  pattern: string
  scope: AllowlistScope
  createdAt: Date
  reason?: string
}

export type AddAllowlistEntryInput = {
  toolName: string
  pattern: string
  reason?: string
}

export type AllowlistRequest = {
  toolName: string
  reason: string
}

export type AllowlistDatabase = Database

export type AllowlistStore = {
  add(entry: AddAllowlistEntryInput): Promise<AllowlistEntry>
  remove(pattern: string): Promise<number>
  isAllowed(request: AllowlistRequest): Promise<boolean>
  list(): Promise<AllowlistEntry[]>
}

export type CreatePermissionAllowlistStoreInput = {
  database: AllowlistDatabase
  workspaceRoot: string
  now?: () => number
  observer?: PermissionObserverPort
}

export function createPermissionAllowlistStore(
  input: CreatePermissionAllowlistStoreInput,
): AllowlistStore {
  const database = input.database
  const workspaceRoot = normalizeAbsolutePath(input.workspaceRoot)
  const now = input.now ?? Date.now
  const observer = input.observer

  return {
    async add(entry) {
      const toolName = normalizeToolName(entry.toolName)
      const pattern = normalizePattern(toolName, entry.pattern, workspaceRoot)
      const createdAt = now()

      database
        .query(
          `
            INSERT INTO permission_allowlist (
              workspace_root,
              tool_name,
              pattern,
              reason,
              created_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (workspace_root, tool_name, pattern)
            DO UPDATE SET
              reason = excluded.reason,
              created_at = excluded.created_at
          `,
        )
        .run(workspaceRoot, toolName, pattern, normalizeOptionalText(entry.reason), createdAt)

      return {
        toolName,
        pattern,
        scope: WORKSPACE_SCOPE,
        createdAt: new Date(createdAt),
        reason: normalizeOptionalText(entry.reason) ?? undefined,
      }
    },
    async remove(pattern) {
      const candidates = buildPatternCandidates(pattern, workspaceRoot)

      if (candidates.length === 0) {
        return 0
      }

      const rows = database
        .query(
          `
            SELECT workspace_root, tool_name, pattern, reason, created_at
            FROM permission_allowlist
            WHERE workspace_root = ?
          `,
        )
        .all(workspaceRoot) as AllowlistRow[]

      let removed = 0

      for (const row of rows) {
        if (!candidates.includes(row.pattern)) {
          continue
        }

        database
          .query(
            `
              DELETE FROM permission_allowlist
              WHERE workspace_root = ? AND tool_name = ? AND pattern = ?
            `,
          )
          .run(workspaceRoot, row.tool_name, row.pattern)
        removed += 1
      }

      return removed
    },
    async isAllowed(request) {
      const toolName = normalizeToolName(request.toolName)
      const rows = database
        .query(
          `
            SELECT workspace_root, tool_name, pattern, reason, created_at
            FROM permission_allowlist
            WHERE workspace_root = ? AND tool_name = ?
            ORDER BY created_at ASC, pattern ASC
          `,
        )
        .all(workspaceRoot, toolName) as AllowlistRow[]

      const matchedRow = rows.find((row) => matchesRequest(row.pattern, request, workspaceRoot))
      const matched = matchedRow != null

      observePermissionEvent(observer, {
        type: "allowlist.checked",
        toolName,
        matched,
      })

      if (matchedRow) {
        observePermissionEvent(observer, {
          type: "allowlist.auto_approved",
          toolName,
          pattern: matchedRow.pattern,
          scope: WORKSPACE_SCOPE,
        })
      }

      return matched
    },
    async list() {
      const rows = database
        .query(
          `
            SELECT workspace_root, tool_name, pattern, reason, created_at
            FROM permission_allowlist
            WHERE workspace_root = ?
            ORDER BY created_at ASC, tool_name ASC, pattern ASC
          `,
        )
        .all(workspaceRoot) as AllowlistRow[]

      return rows.map(mapAllowlistRow)
    },
  }
}

function mapAllowlistRow(row: AllowlistRow): AllowlistEntry {
  return {
    toolName: row.tool_name,
    pattern: row.pattern,
    scope: WORKSPACE_SCOPE,
    createdAt: new Date(row.created_at),
    reason: row.reason ?? undefined,
  }
}

function matchesRequest(pattern: string, request: AllowlistRequest, workspaceRoot: string) {
  const toolName = normalizeToolName(request.toolName)

  if (PATH_GLOB_TOOLS.has(toolName)) {
    return matchWorkspacePathPattern(pattern, extractRequestTarget(request.reason, toolName), workspaceRoot)
  }

  if (toolName === "shell") {
    return extractRequestTarget(request.reason, toolName).trim() === pattern.trim()
  }

  return extractRequestTarget(request.reason, toolName).trim() === pattern.trim()
}

function matchWorkspacePathPattern(pattern: string, rawPath: string, workspaceRoot: string) {
  const candidates = buildWorkspacePathCandidates(rawPath, workspaceRoot)

  if (candidates.length === 0) {
    return false
  }

  const matcher = globToRegExp(pattern)
  return candidates.some((candidate) => matcher.test(candidate))
}

function buildWorkspacePathCandidates(rawPath: string, workspaceRoot: string) {
  const trimmedPath = rawPath.trim()
  if (trimmedPath.length === 0) {
    return []
  }

  const resolvedPath = isAbsolute(trimmedPath)
    ? resolve(trimmedPath)
    : resolve(workspaceRoot, trimmedPath)
  const relativeToWorkspace = normalizePath(relative(workspaceRoot, resolvedPath))

  if (!isWithinWorkspace(relativeToWorkspace)) {
    return []
  }

  const normalizedWorkspacePath = normalizePath(resolvedPath)
  const normalizedRelativePath = normalizeRelativePath(relativeToWorkspace)
  const normalizedInputPath = normalizeRelativePath(trimmedPath)

  return Array.from(
    new Set(
      [normalizedRelativePath, normalizedWorkspacePath, normalizedInputPath].filter(
        (value) => value.length > 0,
      ),
    ),
  )
}

function normalizePattern(toolName: string, pattern: string, workspaceRoot: string) {
  const trimmedPattern = pattern.trim()

  if (trimmedPattern.length === 0) {
    throw new Error("Allowlist pattern must not be empty")
  }

  if (!PATH_GLOB_TOOLS.has(toolName)) {
    return trimmedPattern
  }

  const normalizedPattern = normalizePath(trimmedPattern)
  const workspacePrefix = `${workspaceRoot}/`

  if (normalizedPattern === workspaceRoot) {
    return "."
  }

  if (normalizedPattern.startsWith(workspacePrefix)) {
    return normalizeRelativePath(normalizedPattern.slice(workspacePrefix.length))
  }

  return normalizeRelativePath(normalizedPattern)
}

function buildPatternCandidates(pattern: string, workspaceRoot: string) {
  const trimmedPattern = pattern.trim()

  if (trimmedPattern.length === 0) {
    return []
  }

  const normalizedPattern = normalizePath(trimmedPattern)
  const workspacePrefix = `${workspaceRoot}/`
  const candidates = new Set<string>([trimmedPattern, normalizedPattern])

  if (normalizedPattern.startsWith(workspacePrefix)) {
    candidates.add(normalizeRelativePath(normalizedPattern.slice(workspacePrefix.length)))
  } else {
    candidates.add(normalizeRelativePath(normalizedPattern))
  }

  return Array.from(candidates)
}

function extractRequestTarget(reason: string, toolName: string) {
  const trimmedReason = reason.trim()
  const prefix = `${toolName} `

  if (trimmedReason.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmedReason.slice(prefix.length).trim()
  }

  return trimmedReason
}

function normalizeToolName(toolName: string) {
  const normalizedToolName = toolName.trim()

  if (normalizedToolName.length === 0) {
    throw new Error("Allowlist toolName must not be empty")
  }

  return normalizedToolName
}

function normalizeOptionalText(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function normalizeAbsolutePath(value: string) {
  return normalizePath(resolve(value))
}

function normalizeRelativePath(value: string) {
  const normalized = normalizePath(value)
    .replace(/^\.\//, "")
    .replace(/^\/$/, "")

  return normalized === "" ? "." : normalized
}

function normalizePath(value: string) {
  return value.trim().replaceAll("\\", "/")
}

function isWithinWorkspace(relativePath: string) {
  return relativePath === "" || (!relativePath.startsWith("../") && relativePath !== "..")
}

function globToRegExp(pattern: string) {
  let expression = "^"

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]

    if (character === "*") {
      const nextCharacter = pattern[index + 1]
      const afterNextCharacter = pattern[index + 2]

      if (nextCharacter === "*") {
        if (afterNextCharacter === "/") {
          expression += "(?:.*/)?"
          index += 2
          continue
        }

        expression += ".*"
        index += 1
        continue
      }

      expression += "[^/]*"
      continue
    }

    if (character === "?") {
      expression += "[^/]"
      continue
    }

    expression += escapeRegExpCharacter(character)
  }

  expression += "$"
  return new RegExp(expression)
}

function escapeRegExpCharacter(value: string) {
  return /[|\\{}()[\]^$+?.]/.test(value) ? `\\${value}` : value
}
