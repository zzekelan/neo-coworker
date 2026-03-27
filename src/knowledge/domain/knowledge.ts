export const KNOWLEDGE_CANDIDATE_STATUSES = ["candidate", "saved"] as const
export const KNOWLEDGE_ASSET_KINDS = ["source", "note", "finding", "artifact"] as const

export type KnowledgeCandidateStatus = (typeof KNOWLEDGE_CANDIDATE_STATUSES)[number]
export type KnowledgeAssetKind = (typeof KNOWLEDGE_ASSET_KINDS)[number]

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

export function buildKnowledgeExcerpt(content: string, maxLength = 180) {
  return normalizeKnowledgeText(content, maxLength)
}

export function buildKnowledgeSnippet(content: string, maxLength = 240) {
  return normalizeKnowledgeText(content, maxLength)
}

export function buildKnowledgeAssetDirectory(kind: KnowledgeAssetKind) {
  switch (kind) {
    case "source":
      return "sources"
    case "note":
      return "notes"
    case "finding":
      return "findings"
    case "artifact":
      return "artifacts"
  }
}

export function buildKnowledgeAssetFileName(input: {
  assetId: string
  title: string
  kind: KnowledgeAssetKind
}) {
  const slug = sanitizeKnowledgeFileSegment(input.title) || input.kind
  return `${input.assetId}-${slug}.md`
}

export function sanitizeKnowledgeFileSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "")
    .slice(0, 48)
}

function normalizeKnowledgeText(content: string, maxLength: number) {
  const normalized = content.replace(/\s+/g, " ").trim()

  if (!normalized) {
    return ""
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`
}
