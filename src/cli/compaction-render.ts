type CompactionBoundaryMetadata = {
  tokensBefore: number | null
  tokensAfter: number | null
  compressionRatio: number | null
}

export function isCompactionBoundaryPart(part: { kind: string }) {
  return part.kind === "compaction_boundary"
}

export function formatCompactionBoundaryLine(data: unknown) {
  const metadata = readCompactionBoundaryMetadata(data)
  if (metadata.tokensBefore != null && metadata.tokensAfter != null) {
    const ratioText =
      metadata.compressionRatio != null
        ? `, ${Math.max(0, Math.round(metadata.compressionRatio * 100))}% saved`
        : ""
    return `--- session compacted (${metadata.tokensBefore} -> ${metadata.tokensAfter} tokens${ratioText}) ---\n`
  }

  return "--- session compacted ---\n"
}

function readCompactionBoundaryMetadata(data: unknown): CompactionBoundaryMetadata {
  const record = data != null && typeof data === "object" ? (data as Record<string, unknown>) : null
  return {
    tokensBefore: typeof record?.tokensBefore === "number" ? record.tokensBefore : null,
    tokensAfter: typeof record?.tokensAfter === "number" ? record.tokensAfter : null,
    compressionRatio: typeof record?.compressionRatio === "number" ? record.compressionRatio : null,
  }
}
