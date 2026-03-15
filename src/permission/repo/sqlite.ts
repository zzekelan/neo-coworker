import { Database } from "bun:sqlite"

import type {
  CreatePermissionRequestInput,
  PermissionRepository,
  StoredPermissionRequest,
  UpdatePermissionRequestStatusInput,
} from "./contract"
import { PermissionNotFoundError } from "./contract"

type PermissionRequestRow = {
  id: string
  session_id: string
  run_id: string
  tool_name: string
  reason: string
  status: StoredPermissionRequest["status"]
  created_at: number
  resolved_at: number | null
}

type IdPrefix = "permission"

export type PermissionDatabase = Database

export function createPermissionRepository(input: {
  database: PermissionDatabase
  now?: () => number
  createId?: (prefix: IdPrefix) => string
}): PermissionRepository {
  const database = input.database
  const now = input.now ?? Date.now
  const createId =
    input.createId ?? ((prefix: IdPrefix) => `${prefix}_${crypto.randomUUID()}`)

  function buildId(prefix: IdPrefix, value?: string) {
    return value ?? createId(prefix)
  }

  function getPermissionRequestRow(requestId: string) {
    return database
      .query(
        "SELECT id, session_id, run_id, tool_name, reason, status, created_at, resolved_at FROM permission_request WHERE id = ?",
      )
      .get(requestId) as PermissionRequestRow | null
  }

  function requirePermissionRequest(requestId: string) {
    const row = getPermissionRequestRow(requestId)
    if (!row) {
      throw new PermissionNotFoundError(requestId)
    }

    return mapPermissionRequestRow(row)
  }

  const requests: PermissionRepository["requests"] = {
    create(value: CreatePermissionRequestInput) {
      const record: StoredPermissionRequest = {
        id: buildId("permission", value.id),
        sessionId: value.sessionId,
        runId: value.runId,
        toolName: value.toolName,
        reason: value.reason,
        status: value.status ?? "pending",
        createdAt: value.createdAt ?? now(),
        resolvedAt: value.resolvedAt ?? null,
      }

      database
        .query(
          `
            INSERT INTO permission_request (
              id,
              session_id,
              run_id,
              tool_name,
              reason,
              status,
              created_at,
              resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.id,
          record.sessionId,
          record.runId,
          record.toolName,
          record.reason,
          record.status,
          record.createdAt,
          record.resolvedAt,
        )

      return record
    },
    get(requestId: string) {
      return requirePermissionRequest(requestId)
    },
    listByRun(runId: string) {
      const rows = database
        .query(
          `
            SELECT id, session_id, run_id, tool_name, reason, status, created_at, resolved_at
            FROM permission_request
            WHERE run_id = ?
            ORDER BY created_at ASC, id ASC
          `,
        )
        .all(runId) as PermissionRequestRow[]

      return rows.map(mapPermissionRequestRow)
    },
    updateStatus(value: UpdatePermissionRequestStatusInput) {
      const current = requirePermissionRequest(value.requestId)
      const record: StoredPermissionRequest = {
        ...current,
        status: value.status,
        resolvedAt: value.resolvedAt === undefined ? current.resolvedAt : value.resolvedAt,
      }

      database
        .query("UPDATE permission_request SET status = ?, resolved_at = ? WHERE id = ?")
        .run(record.status, record.resolvedAt, record.id)

      return record
    },
  }

  return {
    requests,
  }
}

function mapPermissionRequestRow(row: PermissionRequestRow): StoredPermissionRequest {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    toolName: row.tool_name,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}
