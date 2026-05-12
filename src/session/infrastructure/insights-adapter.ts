import {
  summarizeSessionInsights,
  type InsightsPort,
  type InsightsQuery,
  type SessionInsight,
} from "../domain"
import type { SessionDatabase } from "./sqlite"

type CreateSessionInsightsAdapterInput = {
  database: SessionDatabase
}

type SessionRow = {
  id: string
  created_at: number
}

type RunRow = {
  id: string
  session_id: string
  trigger: string
  status: string
  finished_at: number | null
  input_tokens: number
  output_tokens: number
  token_usage_source: "provider" | "estimated" | null
}

type PartAggregateRow = {
  session_id: string
  kind: "tool_call" | "compaction_boundary"
  data_json: string | null
}

type MessagePartTextRow = {
  run_id: string
  role: "user" | "assistant" | "compaction"
  text_value: string | null
}

type RunTokenUsage = {
  input: number
  output: number
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_permission"])
const APPROX_CHARS_PER_TOKEN = 4

export function createSessionInsightsAdapter(
  input: CreateSessionInsightsAdapterInput,
): InsightsPort {
  const database = input.database

  return {
    async getSessionInsight(sessionId) {
      const [session] = listSessionRows(database, {
        sessionIds: [sessionId],
        limit: 1,
      })

      if (!session) {
        return null
      }

      return buildSessionInsights(database, [session])[0] ?? null
    },
    async querySessions(query) {
      const limit = normalizeLimit(query.limit)
      if (limit === 0) {
        return []
      }

      const sessionRows = listSessionRows(database, {
        ...query,
        limit,
      })

      return buildSessionInsights(database, sessionRows)
    },
    summarize(insights) {
      return summarizeSessionInsights(insights)
    },
  }
}

function buildSessionInsights(database: SessionDatabase, sessionRows: SessionRow[]): SessionInsight[] {
  if (sessionRows.length === 0) {
    return []
  }

  const sessionIds = sessionRows.map((session) => session.id)
  const runRows = listRunRows(database, sessionIds)
  const partRows = listPartAggregateRows(database, sessionIds)
  const approximateRunIds = runRows
    .filter((run) => run.token_usage_source === null)
    .map((run) => run.id)
  const approximateTokensByRun = listApproximateRunTokens(database, approximateRunIds)

  const runsBySession = groupRunsBySession(runRows)
  const toolUsageBySession = new Map<string, Map<string, number>>()
  const compactionCountBySession = new Map<string, number>()

  for (const row of partRows) {
    if (row.kind === "compaction_boundary") {
      compactionCountBySession.set(
        row.session_id,
        (compactionCountBySession.get(row.session_id) ?? 0) + 1,
      )
      continue
    }

    const toolName = readToolName(row.data_json)
    if (!toolName) {
      continue
    }

    const toolUsage = getOrCreateMap(toolUsageBySession, row.session_id)
    toolUsage.set(toolName, (toolUsage.get(toolName) ?? 0) + 1)
  }

  return sessionRows.map((sessionRow) => {
    const sessionRunRows = runsBySession.get(sessionRow.id) ?? []
    const tokenUsage = aggregateSessionTokenUsage(sessionRunRows, approximateTokensByRun)
    const latestFinishedAt = findLatestFinishedAt(sessionRunRows)
    const hasActiveRun = sessionRunRows.some((run) => ACTIVE_RUN_STATUSES.has(run.status))

    return {
      sessionId: sessionRow.id,
      startedAt: new Date(sessionRow.created_at),
      endedAt:
        !hasActiveRun && latestFinishedAt !== null ? new Date(latestFinishedAt) : undefined,
      totalTokens: tokenUsage,
      toolUsage: new Map(toolUsageBySession.get(sessionRow.id) ?? []),
      turnCount: sessionRunRows.reduce(
        (count, run) => count + (run.trigger === "summarize" ? 0 : 1),
        0,
      ),
      compactionCount: compactionCountBySession.get(sessionRow.id) ?? 0,
    }
  })
}

function listSessionRows(
  database: SessionDatabase,
  query: Pick<InsightsQuery, "from" | "to" | "sessionIds" | "limit">,
) {
  const normalizedSessionIds = normalizeSessionIds(query.sessionIds)
  if (query.sessionIds && normalizedSessionIds.length === 0) {
    return [] as SessionRow[]
  }

  const clauses: string[] = []
  const parameters: Array<number | string> = []

  if (query.from) {
    clauses.push("created_at >= ?")
    parameters.push(query.from.getTime())
  }

  if (query.to) {
    clauses.push("created_at <= ?")
    parameters.push(query.to.getTime())
  }

  if (normalizedSessionIds.length > 0) {
    clauses.push(`id IN (${createPlaceholders(normalizedSessionIds.length)})`)
    parameters.push(...normalizedSessionIds)
  }

  let sql = "SELECT id, created_at FROM session"
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`
  }
  sql += " ORDER BY created_at DESC, id ASC"

  if (query.limit !== undefined) {
    sql += " LIMIT ?"
    parameters.push(query.limit)
  }

  return database.query(sql).all(...parameters) as SessionRow[]
}

function listRunRows(database: SessionDatabase, sessionIds: string[]) {
  if (sessionIds.length === 0) {
    return [] as RunRow[]
  }

  return database
    .query(
      `
        SELECT
          id,
          session_id,
          trigger,
          status,
          finished_at,
          input_tokens,
          output_tokens,
          token_usage_source
        FROM run
        WHERE session_id IN (${createPlaceholders(sessionIds.length)})
      `,
    )
    .all(...sessionIds) as RunRow[]
}

function listPartAggregateRows(database: SessionDatabase, sessionIds: string[]) {
  if (sessionIds.length === 0) {
    return [] as PartAggregateRow[]
  }

  return database
    .query(
      `
        SELECT session_id, kind, data_json
        FROM part
        WHERE session_id IN (${createPlaceholders(sessionIds.length)})
          AND kind IN ('tool_call', 'compaction_boundary')
      `,
    )
    .all(...sessionIds) as PartAggregateRow[]
}

function listApproximateRunTokens(database: SessionDatabase, runIds: string[]) {
  const approximateTokensByRun = new Map<string, RunTokenUsage>()
  if (runIds.length === 0) {
    return approximateTokensByRun
  }

  const rows = database
    .query(
      `
        SELECT message.run_id, message.role, part.text_value
        FROM message
        LEFT JOIN part ON part.message_id = message.id
        WHERE message.run_id IN (${createPlaceholders(runIds.length)})
        ORDER BY message.run_id ASC, message.sequence ASC, part.sequence ASC, part.id ASC
      `,
    )
    .all(...runIds) as MessagePartTextRow[]

  for (const runId of runIds) {
    approximateTokensByRun.set(runId, {
      input: 0,
      output: 0,
    })
  }

  for (const row of rows) {
    const text = row.text_value ?? ""
    if (text.length === 0) {
      continue
    }

    const current = approximateTokensByRun.get(row.run_id)
    if (!current) {
      continue
    }

    if (row.role === "user") {
      current.input += approximateTokensFromText(text)
      continue
    }

    current.output += approximateTokensFromText(text)
  }

  return approximateTokensByRun
}

function aggregateSessionTokenUsage(
  runRows: RunRow[],
  approximateTokensByRun: Map<string, RunTokenUsage>,
) {
  return runRows.reduce(
    (total, run) => {
      if (run.token_usage_source === null) {
        const approximate = approximateTokensByRun.get(run.id)
        total.input += approximate?.input ?? 0
        total.output += approximate?.output ?? 0
        return total
      }

      total.input += run.input_tokens
      total.output += run.output_tokens
      return total
    },
    {
      input: 0,
      output: 0,
    },
  )
}

function groupRunsBySession(runRows: RunRow[]) {
  const runsBySession = new Map<string, RunRow[]>()

  for (const run of runRows) {
    const runs = getOrCreateArray(runsBySession, run.session_id)
    runs.push(run)
  }

  return runsBySession
}

function findLatestFinishedAt(runRows: RunRow[]) {
  let latestFinishedAt: number | null = null

  for (const run of runRows) {
    if (run.finished_at === null) {
      continue
    }

    latestFinishedAt =
      latestFinishedAt === null ? run.finished_at : Math.max(latestFinishedAt, run.finished_at)
  }

  return latestFinishedAt
}

function readToolName(dataJson: string | null) {
  if (!dataJson) {
    return null
  }

  try {
    const parsed = JSON.parse(dataJson) as Record<string, unknown>
    return typeof parsed.toolName === "string" && parsed.toolName.length > 0
      ? parsed.toolName
      : null
  } catch {
    return null
  }
}

function approximateTokensFromText(text: string) {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

function createPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ")
}

function normalizeSessionIds(sessionIds: string[] | undefined) {
  return [...new Set((sessionIds ?? []).filter((sessionId) => sessionId.length > 0))]
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined) {
    return undefined
  }

  return Math.max(0, Math.floor(limit))
}

function getOrCreateMap(
  map: Map<string, Map<string, number>>,
  key: string,
): Map<string, number> {
  const existing = map.get(key)
  if (existing) {
    return existing
  }

  const created = new Map<string, number>()
  map.set(key, created)
  return created
}

function getOrCreateArray(map: Map<string, RunRow[]>, key: string) {
  const existing = map.get(key)
  if (existing) {
    return existing
  }

  const created: RunRow[] = []
  map.set(key, created)
  return created
}

export type { CreateSessionInsightsAdapterInput }
