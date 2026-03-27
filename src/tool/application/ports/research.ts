export type ResearchToolAssetSummary = {
  id: string
  kind: string
  title: string
  path: string
  snippet: string
  sourceUrl: string | null
}

export type ResearchToolSearchMatch = {
  id: string
  kind: string
  title: string
  snippet: string
}

export type ResearchToolAssetDocument = {
  id: string
  kind: string
  title: string
  path: string
  content: string
  sourceUrl: string | null
}

export type ResearchToolCandidateSummary = {
  id: string
  title: string
  sourceUrl: string
  excerpt: string
}

export type ExternalContentDocument = {
  title: string
  sourceUrl: string
  content: string
  contentType: string | null
}

export type BuiltinResearchToolCallbacks = {
  stageFetchedSource(input: {
    workspaceRoot: string
    sessionId?: string
    runId?: string
    title: string
    sourceUrl: string
    content: string
  }): Promise<ResearchToolCandidateSummary> | ResearchToolCandidateSummary
  listAssets(input: {
    workspaceRoot: string
    kind?: string
  }): Promise<ResearchToolAssetSummary[]> | ResearchToolAssetSummary[]
  readAsset(input: {
    workspaceRoot: string
    assetId: string
  }): Promise<ResearchToolAssetDocument> | ResearchToolAssetDocument
  searchAssets(input: {
    workspaceRoot: string
    query: string
    kind?: string
  }): Promise<ResearchToolSearchMatch[]> | ResearchToolSearchMatch[]
  writeAsset(input: {
    workspaceRoot: string
    sessionId?: string
    runId?: string
    kind: string
    title: string
    content: string
  }): Promise<ResearchToolAssetSummary> | ResearchToolAssetSummary
  fetchExternalContent?(input: {
    url: string
    signal?: AbortSignal
  }): Promise<ExternalContentDocument> | ExternalContentDocument
}
