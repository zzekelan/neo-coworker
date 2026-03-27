export type KnowledgeAssetKind = "source" | "note" | "finding" | "artifact"

export type KnowledgeStoragePort = {
  writeAssetFile(input: {
    workspaceRoot: string
    kind: KnowledgeAssetKind
    assetId: string
    title: string
    content: string
    sourceUrl?: string | null
    createdAt: number
  }): Promise<{ path: string }>
  readAssetFile(input: {
    workspaceRoot: string
    path: string
  }): Promise<string>
}
