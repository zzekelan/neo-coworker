export type KnowledgeCandidateStatus = "candidate" | "saved"
export type KnowledgeAssetKind = "source" | "note" | "finding" | "artifact"

export type StoredKnowledgeCandidate = {
  id: string
  workspaceRoot: string
  sessionId: string | null
  runId: string | null
  sourceType: "web_fetch"
  title: string
  sourceUrl: string
  excerpt: string
  content: string
  status: KnowledgeCandidateStatus
  createdAt: number
  savedAt: number | null
  savedAssetId: string | null
}

export type StoredKnowledgeAsset = {
  id: string
  workspaceRoot: string
  sessionId: string | null
  runId: string | null
  kind: KnowledgeAssetKind
  title: string
  path: string
  snippet: string
  sourceUrl: string | null
  sourceCandidateId: string | null
  createdAt: number
  updatedAt: number
}

export type CreateKnowledgeCandidateInput = {
  id?: string
  workspaceRoot: string
  sessionId?: string | null
  runId?: string | null
  sourceType: "web_fetch"
  title: string
  sourceUrl: string
  excerpt: string
  content: string
  status?: KnowledgeCandidateStatus
  createdAt?: number
  savedAt?: number | null
  savedAssetId?: string | null
}

export type UpdateKnowledgeCandidateInput = {
  candidateId: string
  status?: KnowledgeCandidateStatus
  savedAt?: number | null
  savedAssetId?: string | null
}

export type CreateKnowledgeAssetInput = {
  id?: string
  workspaceRoot: string
  sessionId?: string | null
  runId?: string | null
  kind: KnowledgeAssetKind
  title: string
  path: string
  snippet: string
  sourceUrl?: string | null
  sourceCandidateId?: string | null
  createdAt?: number
  updatedAt?: number
}

export class KnowledgeRepositoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KnowledgeRepositoryError"
  }
}

export class KnowledgeNotFoundError extends KnowledgeRepositoryError {
  readonly entityType: "candidate" | "asset"
  readonly entityId: string

  constructor(entityType: "candidate" | "asset", entityId: string) {
    super(`Unknown ${entityType}: ${entityId}`)
    this.name = "KnowledgeNotFoundError"
    this.entityType = entityType
    this.entityId = entityId
  }
}

export type KnowledgeRepository = {
  candidates: {
    create(candidate: CreateKnowledgeCandidateInput): StoredKnowledgeCandidate
    get(candidateId: string): StoredKnowledgeCandidate
    listByWorkspace(workspaceRoot: string): StoredKnowledgeCandidate[]
    update(candidate: UpdateKnowledgeCandidateInput): StoredKnowledgeCandidate
  }
  assets: {
    create(asset: CreateKnowledgeAssetInput): StoredKnowledgeAsset
    get(assetId: string): StoredKnowledgeAsset
    listByWorkspace(workspaceRoot: string, kind?: KnowledgeAssetKind): StoredKnowledgeAsset[]
  }
}
