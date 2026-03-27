import {
  buildKnowledgeExcerpt,
  buildKnowledgeSnippet,
  type KnowledgeAssetKind,
  type StoredKnowledgeAsset,
} from "../domain"
import type { KnowledgeRepository } from "./ports/repository"
import type { KnowledgeStoragePort } from "./ports/storage"

export type CreateKnowledgeRuntimeApiInput = {
  repository: KnowledgeRepository
  storage: KnowledgeStoragePort
  now?: () => number
}

export function createKnowledgeRuntimeApi(input: CreateKnowledgeRuntimeApiInput) {
  const now = input.now ?? Date.now

  return {
    candidates: {
      stage(candidate: {
        workspaceRoot: string
        sessionId?: string | null
        runId?: string | null
        title: string
        sourceUrl: string
        content: string
      }) {
        return input.repository.candidates.create({
          workspaceRoot: candidate.workspaceRoot,
          sessionId: candidate.sessionId ?? null,
          runId: candidate.runId ?? null,
          sourceType: "web_fetch",
          title: candidate.title,
          sourceUrl: candidate.sourceUrl,
          excerpt: buildKnowledgeExcerpt(candidate.content),
          content: candidate.content,
          status: "candidate",
          createdAt: now(),
        })
      },
      get(candidateId: string) {
        return input.repository.candidates.get(candidateId)
      },
      list(workspaceRoot: string) {
        return input.repository.candidates.listByWorkspace(workspaceRoot)
      },
      async saveAsSource(saveInput: {
        candidateId: string
        title?: string
      }) {
        const candidate = input.repository.candidates.get(saveInput.candidateId)
        const title = saveInput.title?.trim() || candidate.title
        const assetId = `asset_${crypto.randomUUID()}`
        const createdAt = now()
        const file = await input.storage.writeAssetFile({
          workspaceRoot: candidate.workspaceRoot,
          kind: "source",
          assetId,
          title,
          content: candidate.content,
          sourceUrl: candidate.sourceUrl,
          createdAt,
        })
        const asset = input.repository.assets.create({
          id: assetId,
          workspaceRoot: candidate.workspaceRoot,
          sessionId: candidate.sessionId,
          runId: candidate.runId,
          kind: "source",
          title,
          path: file.path,
          snippet: buildKnowledgeSnippet(candidate.content),
          sourceUrl: candidate.sourceUrl,
          sourceCandidateId: candidate.id,
          createdAt,
          updatedAt: createdAt,
        })

        const updatedCandidate = input.repository.candidates.update({
          candidateId: candidate.id,
          status: "saved",
          savedAt: createdAt,
          savedAssetId: asset.id,
        })

        return {
          candidate: updatedCandidate,
          asset,
        }
      },
    },
    assets: {
      async create(assetInput: {
        workspaceRoot: string
        sessionId?: string | null
        runId?: string | null
        kind: KnowledgeAssetKind
        title: string
        content: string
        sourceUrl?: string | null
        sourceCandidateId?: string | null
      }) {
        const assetId = `asset_${crypto.randomUUID()}`
        const createdAt = now()
        const file = await input.storage.writeAssetFile({
          workspaceRoot: assetInput.workspaceRoot,
          kind: assetInput.kind,
          assetId,
          title: assetInput.title,
          content: assetInput.content,
          sourceUrl: assetInput.sourceUrl ?? null,
          createdAt,
        })

        return input.repository.assets.create({
          id: assetId,
          workspaceRoot: assetInput.workspaceRoot,
          sessionId: assetInput.sessionId ?? null,
          runId: assetInput.runId ?? null,
          kind: assetInput.kind,
          title: assetInput.title,
          path: file.path,
          snippet: buildKnowledgeSnippet(assetInput.content),
          sourceUrl: assetInput.sourceUrl ?? null,
          sourceCandidateId: assetInput.sourceCandidateId ?? null,
          createdAt,
          updatedAt: createdAt,
        })
      },
      get(assetId: string) {
        return input.repository.assets.get(assetId)
      },
      list(workspaceRoot: string, kind?: KnowledgeAssetKind) {
        return input.repository.assets.listByWorkspace(workspaceRoot, kind)
      },
      async read(assetId: string) {
        const asset = input.repository.assets.get(assetId)
        const content = await input.storage.readAssetFile({
          workspaceRoot: asset.workspaceRoot,
          path: asset.path,
        })

        return {
          asset,
          content,
        }
      },
      async search(searchInput: {
        workspaceRoot: string
        query: string
        kind?: KnowledgeAssetKind
      }) {
        const normalizedQuery = searchInput.query.trim().toLowerCase()
        const assets = input.repository.assets.listByWorkspace(
          searchInput.workspaceRoot,
          searchInput.kind,
        )
        const matches: Array<{
          asset: StoredKnowledgeAsset
          snippet: string
        }> = []

        for (const asset of assets) {
          const content = await input.storage.readAssetFile({
            workspaceRoot: asset.workspaceRoot,
            path: asset.path,
          })
          const haystack = `${asset.title}\n${content}`.toLowerCase()

          if (!haystack.includes(normalizedQuery)) {
            continue
          }

          matches.push({
            asset,
            snippet: buildSearchSnippet(content, normalizedQuery),
          })
        }

        return matches
      },
    },
  }
}

function buildSearchSnippet(content: string, query: string) {
  const normalized = content.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return ""
  }

  const lower = normalized.toLowerCase()
  const index = lower.indexOf(query)

  if (index === -1) {
    return buildKnowledgeExcerpt(normalized)
  }

  const start = Math.max(0, index - 60)
  const end = Math.min(normalized.length, index + query.length + 100)
  const snippet = normalized.slice(start, end).trim()

  if (start > 0 && end < normalized.length) {
    return `... ${snippet} ...`
  }

  if (start > 0) {
    return `... ${snippet}`
  }

  if (end < normalized.length) {
    return `${snippet} ...`
  }

  return snippet
}
