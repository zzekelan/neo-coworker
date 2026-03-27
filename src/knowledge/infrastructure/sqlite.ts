import { Database } from "bun:sqlite"
import {
  KNOWLEDGE_ASSET_KINDS,
  KNOWLEDGE_CANDIDATE_STATUSES,
  type StoredKnowledgeAsset,
  type StoredKnowledgeCandidate,
} from "../domain"
import {
  KnowledgeNotFoundError,
  type CreateKnowledgeAssetInput,
  type CreateKnowledgeCandidateInput,
  type KnowledgeRepository,
  type UpdateKnowledgeCandidateInput,
} from "../application"

type KnowledgeCandidateRow = {
  id: string
  workspace_root: string
  session_id: string | null
  run_id: string | null
  source_type: "web_fetch"
  title: string
  source_url: string
  excerpt: string
  content: string
  status: StoredKnowledgeCandidate["status"]
  created_at: number
  saved_at: number | null
  saved_asset_id: string | null
}

type KnowledgeAssetRow = {
  id: string
  workspace_root: string
  session_id: string | null
  run_id: string | null
  kind: StoredKnowledgeAsset["kind"]
  title: string
  path: string
  snippet: string
  source_url: string | null
  source_candidate_id: string | null
  created_at: number
  updated_at: number
}

type IdPrefix = "candidate" | "asset"

export type KnowledgeDatabase = Database

const candidateStatusCheck = KNOWLEDGE_CANDIDATE_STATUSES.map((status) => `'${status}'`).join(", ")
const assetKindCheck = KNOWLEDGE_ASSET_KINDS.map((kind) => `'${kind}'`).join(", ")

export function createKnowledgeRepository(input: {
  database: KnowledgeDatabase
  now?: () => number
  createId?: (prefix: IdPrefix) => string
}): KnowledgeRepository {
  const database = input.database
  const now = input.now ?? Date.now
  const createId =
    input.createId ?? ((prefix: IdPrefix) => `${prefix}_${crypto.randomUUID()}`)

  ensureKnowledgeTables(database)

  function buildId(prefix: IdPrefix, value?: string) {
    return value ?? createId(prefix)
  }

  function getCandidateRow(candidateId: string) {
    return database
      .query(
        `
          SELECT
            id,
            workspace_root,
            session_id,
            run_id,
            source_type,
            title,
            source_url,
            excerpt,
            content,
            status,
            created_at,
            saved_at,
            saved_asset_id
          FROM knowledge_candidate
          WHERE id = ?
        `,
      )
      .get(candidateId) as KnowledgeCandidateRow | null
  }

  function getAssetRow(assetId: string) {
    return database
      .query(
        `
          SELECT
            id,
            workspace_root,
            session_id,
            run_id,
            kind,
            title,
            path,
            snippet,
            source_url,
            source_candidate_id,
            created_at,
            updated_at
          FROM knowledge_asset
          WHERE id = ?
        `,
      )
      .get(assetId) as KnowledgeAssetRow | null
  }

  const candidates: KnowledgeRepository["candidates"] = {
    create(value: CreateKnowledgeCandidateInput) {
      const record: StoredKnowledgeCandidate = {
        id: buildId("candidate", value.id),
        workspaceRoot: value.workspaceRoot,
        sessionId: value.sessionId ?? null,
        runId: value.runId ?? null,
        sourceType: value.sourceType,
        title: value.title,
        sourceUrl: value.sourceUrl,
        excerpt: value.excerpt,
        content: value.content,
        status: value.status ?? "candidate",
        createdAt: value.createdAt ?? now(),
        savedAt: value.savedAt ?? null,
        savedAssetId: value.savedAssetId ?? null,
      }

      database
        .query(
          `
            INSERT INTO knowledge_candidate (
              id,
              workspace_root,
              session_id,
              run_id,
              source_type,
              title,
              source_url,
              excerpt,
              content,
              status,
              created_at,
              saved_at,
              saved_asset_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.id,
          record.workspaceRoot,
          record.sessionId,
          record.runId,
          record.sourceType,
          record.title,
          record.sourceUrl,
          record.excerpt,
          record.content,
          record.status,
          record.createdAt,
          record.savedAt,
          record.savedAssetId,
        )

      return record
    },
    get(candidateId: string) {
      const row = getCandidateRow(candidateId)
      if (!row) {
        throw new KnowledgeNotFoundError("candidate", candidateId)
      }

      return mapCandidateRow(row)
    },
    listByWorkspace(workspaceRoot: string) {
      const rows = database
        .query(
          `
            SELECT
              id,
              workspace_root,
              session_id,
              run_id,
              source_type,
              title,
              source_url,
              excerpt,
              content,
              status,
              created_at,
              saved_at,
              saved_asset_id
            FROM knowledge_candidate
            WHERE workspace_root = ?
            ORDER BY created_at DESC, id DESC
          `,
        )
        .all(workspaceRoot) as KnowledgeCandidateRow[]

      return rows.map(mapCandidateRow)
    },
    update(value: UpdateKnowledgeCandidateInput) {
      const current = candidates.get(value.candidateId)
      const record: StoredKnowledgeCandidate = {
        ...current,
        status: value.status ?? current.status,
        savedAt: value.savedAt === undefined ? current.savedAt : value.savedAt,
        savedAssetId:
          value.savedAssetId === undefined ? current.savedAssetId : value.savedAssetId,
      }

      database
        .query(
          `
            UPDATE knowledge_candidate
            SET status = ?, saved_at = ?, saved_asset_id = ?
            WHERE id = ?
          `,
        )
        .run(record.status, record.savedAt, record.savedAssetId, record.id)

      return record
    },
  }

  const assets: KnowledgeRepository["assets"] = {
    create(value: CreateKnowledgeAssetInput) {
      const record: StoredKnowledgeAsset = {
        id: buildId("asset", value.id),
        workspaceRoot: value.workspaceRoot,
        sessionId: value.sessionId ?? null,
        runId: value.runId ?? null,
        kind: value.kind,
        title: value.title,
        path: value.path,
        snippet: value.snippet,
        sourceUrl: value.sourceUrl ?? null,
        sourceCandidateId: value.sourceCandidateId ?? null,
        createdAt: value.createdAt ?? now(),
        updatedAt: value.updatedAt ?? value.createdAt ?? now(),
      }

      database
        .query(
          `
            INSERT INTO knowledge_asset (
              id,
              workspace_root,
              session_id,
              run_id,
              kind,
              title,
              path,
              snippet,
              source_url,
              source_candidate_id,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.id,
          record.workspaceRoot,
          record.sessionId,
          record.runId,
          record.kind,
          record.title,
          record.path,
          record.snippet,
          record.sourceUrl,
          record.sourceCandidateId,
          record.createdAt,
          record.updatedAt,
        )

      return record
    },
    get(assetId: string) {
      const row = getAssetRow(assetId)
      if (!row) {
        throw new KnowledgeNotFoundError("asset", assetId)
      }

      return mapAssetRow(row)
    },
    listByWorkspace(workspaceRoot: string, kind?) {
      const rows = (kind
        ? database
            .query(
              `
                SELECT
                  id,
                  workspace_root,
                  session_id,
                  run_id,
                  kind,
                  title,
                  path,
                  snippet,
                  source_url,
                  source_candidate_id,
                  created_at,
                  updated_at
                FROM knowledge_asset
                WHERE workspace_root = ? AND kind = ?
                ORDER BY created_at DESC, id DESC
              `,
            )
            .all(workspaceRoot, kind)
        : database
            .query(
              `
                SELECT
                  id,
                  workspace_root,
                  session_id,
                  run_id,
                  kind,
                  title,
                  path,
                  snippet,
                  source_url,
                  source_candidate_id,
                  created_at,
                  updated_at
                FROM knowledge_asset
                WHERE workspace_root = ?
                ORDER BY created_at DESC, id DESC
              `,
            )
            .all(workspaceRoot)) as KnowledgeAssetRow[]

      return rows.map(mapAssetRow)
    },
  }

  return {
    candidates,
    assets,
  }
}

function ensureKnowledgeTables(database: KnowledgeDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_candidate (
      id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (${candidateStatusCheck})),
      created_at INTEGER NOT NULL,
      saved_at INTEGER,
      saved_asset_id TEXT
    );

    CREATE INDEX IF NOT EXISTS knowledge_candidate_workspace_idx
    ON knowledge_candidate (workspace_root, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS knowledge_asset (
      id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN (${assetKindCheck})),
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      snippet TEXT NOT NULL,
      source_url TEXT,
      source_candidate_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS knowledge_asset_workspace_idx
    ON knowledge_asset (workspace_root, created_at DESC, id DESC);
  `)
}

function mapCandidateRow(row: KnowledgeCandidateRow): StoredKnowledgeCandidate {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    sessionId: row.session_id,
    runId: row.run_id,
    sourceType: row.source_type,
    title: row.title,
    sourceUrl: row.source_url,
    excerpt: row.excerpt,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    savedAt: row.saved_at,
    savedAssetId: row.saved_asset_id,
  }
}

function mapAssetRow(row: KnowledgeAssetRow): StoredKnowledgeAsset {
  return {
    id: row.id,
    workspaceRoot: row.workspace_root,
    sessionId: row.session_id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    path: row.path,
    snippet: row.snippet,
    sourceUrl: row.source_url,
    sourceCandidateId: row.source_candidate_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
