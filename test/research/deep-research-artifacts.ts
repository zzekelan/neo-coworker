import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, posix, relative, sep } from "node:path"

type SourceType = "web" | "docs" | "files"
type FindingConfidence = "high" | "medium" | "low"

export type SourceNoteCandidate = {
  proposedType: SourceType
  title: string
  uriOrPath: string
  retrievedAt: string
  reliability: string
  relevance: string
  supports: string[]
  contradicts: string[]
  keyExcerpts: string[]
  caveats: string[]
  suggestedTags: string[]
  accepted: boolean
  contentHash?: string
}

type ResearchWorkflowInput = {
  topic: string
  title: string
  summary: string
  updated: string
  tags: string[]
  finding: {
    claim: string
    scope: string
    confidence: FindingConfidence
    notes: string
  }
  sourceNotes: SourceNoteCandidate[]
}

type AcceptedSource = SourceNoteCandidate & {
  id: string
  artifactPath: string
  relativeEvidencePath: string
}

const SOURCE_PREFIX_BY_TYPE: Record<SourceType, string> = {
  web: "W",
  docs: "D",
  files: "F",
}

export function collectSourceNoteCandidate(input: SourceNoteCandidate): SourceNoteCandidate {
  return {
    ...input,
    supports: [...input.supports],
    contradicts: [...input.contradicts],
    keyExcerpts: [...input.keyExcerpts],
    caveats: [...input.caveats],
    suggestedTags: [...input.suggestedTags],
  }
}

export async function runPrimaryResearchArtifactWorkflow(workspaceRoot: string, input: ResearchWorkflowInput) {
  const topicSlug = slugify(input.topic)
  const acceptedSources = assignAcceptedSources(topicSlug, input.sourceNotes.filter((note) => note.accepted))
  const writtenPaths = [
    ".ncoworker/research/index.md",
    `.ncoworker/research/${topicSlug}/brief.md`,
    `.ncoworker/research/${topicSlug}/findings.md`,
    `.ncoworker/research/${topicSlug}/open-questions.md`,
    `.ncoworker/research/${topicSlug}/sources/index.md`,
    ...acceptedSources.map((source) => source.artifactPath),
  ].map(assertResearchArtifactPath)

  await writeResearchFile(workspaceRoot, writtenPaths[0], renderWorkspaceIndex(topicSlug, input))
  await writeResearchFile(workspaceRoot, writtenPaths[1], renderBrief(topicSlug, input))
  await writeResearchFile(workspaceRoot, writtenPaths[2], renderFindings(topicSlug, input, acceptedSources))
  await writeResearchFile(workspaceRoot, writtenPaths[3], renderOpenQuestions(topicSlug, acceptedSources))
  await writeResearchFile(workspaceRoot, writtenPaths[4], renderSourcesIndex(topicSlug, acceptedSources))

  for (const source of acceptedSources) {
    await writeResearchFile(workspaceRoot, source.artifactPath, renderSourceRecord(source))
  }

  return { topicSlug, writtenPaths }
}

export function assertResearchArtifactPath(path: string) {
  if (isAbsolute(path)) {
    throw new Error("Research artifact paths must be workspace-relative")
  }

  const normalized = posix.normalize(path.replaceAll("\\", "/"))
  if (normalized !== ".ncoworker/research/index.md" && !normalized.startsWith(".ncoworker/research/")) {
    throw new Error(`Research artifact path is outside .ncoworker/research: ${path}`)
  }
  if (normalized.endsWith("/..") || normalized.includes("/../")) {
    throw new Error(`Research artifact path is outside .ncoworker/research: ${path}`)
  }

  return normalized
}

export async function readResearchTree(workspaceRoot: string) {
  const researchRoot = join(workspaceRoot, ".ncoworker/research")
  const files: Record<string, string> = {}

  try {
    await readDirectory(researchRoot)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return files
    }
    throw error
  }

  async function readDirectory(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await readDirectory(absolutePath)
      } else if (entry.isFile()) {
        const relativePath = relative(workspaceRoot, absolutePath).split(sep).join("/")
        files[relativePath] = await readFile(absolutePath, "utf8")
      }
    }
  }

  return files
}

function assignAcceptedSources(topicSlug: string, sourceNotes: SourceNoteCandidate[]): AcceptedSource[] {
  const counts: Record<SourceType, number> = { web: 0, docs: 0, files: 0 }

  return sourceNotes.map((note) => {
    counts[note.proposedType] += 1
    const id = `${SOURCE_PREFIX_BY_TYPE[note.proposedType]}${String(counts[note.proposedType]).padStart(3, "0")}`
    const sourceSlug = slugify(note.title)
    return {
      ...note,
      id,
      artifactPath: `.ncoworker/research/${topicSlug}/sources/${note.proposedType}/${id}-${sourceSlug}.md`,
      relativeEvidencePath: `sources/${note.proposedType}/${id}-${sourceSlug}.md`,
    }
  })
}

async function writeResearchFile(workspaceRoot: string, artifactPath: string, contents: string) {
  const safePath = assertResearchArtifactPath(artifactPath)
  const absolutePath = join(workspaceRoot, safePath)
  await mkdir(join(absolutePath, ".."), { recursive: true })
  await writeFile(absolutePath, `${contents}\n`)
}

function renderWorkspaceIndex(topicSlug: string, input: ResearchWorkflowInput) {
  return [
    "# Research Index",
    "",
    "Research artifacts live under:",
    "",
    "```text",
    ".ncoworker/research/",
    "```",
    "",
    "Each living topic directory contains:",
    "",
    "- `brief.md`",
    "- `findings.md`",
    "- `open-questions.md`",
    "- `sources/index.md`",
    "- `sources/web/W001-<slug>.md`",
    "- `sources/docs/D001-<slug>.md`",
    "- `sources/files/F001-<slug>.md`",
    "",
    "## Artifact Paths",
    "",
    "```text",
    ".ncoworker/research/index.md",
    ".ncoworker/research/<topic>/brief.md",
    ".ncoworker/research/<topic>/findings.md",
    ".ncoworker/research/<topic>/open-questions.md",
    ".ncoworker/research/<topic>/sources/index.md",
    ".ncoworker/research/<topic>/sources/web/W001-<slug>.md",
    ".ncoworker/research/<topic>/sources/docs/D001-<slug>.md",
    ".ncoworker/research/<topic>/sources/files/F001-<slug>.md",
    "```",
    "",
    "## Topics",
    "",
    `- [${topicSlug}](${topicSlug}/brief.md) — ${input.title}; updated ${input.updated}`,
  ].join("\n")
}

function renderBrief(topicSlug: string, input: ResearchWorkflowInput) {
  return [
    `# ${topicSlug} Research Brief`,
    "",
    `- **Topic:** ${topicSlug}`,
    `- **Title:** ${input.title}`,
    `- **Summary:** ${input.summary}`,
    "- **Status:** active",
    `- **Updated:** ${input.updated}`,
    `- **Tags:** ${input.tags.join(", ")}`,
    "",
    "## Brief",
    "",
    input.summary,
  ].join("\n")
}

function renderFindings(topicSlug: string, input: ResearchWorkflowInput, acceptedSources: AcceptedSource[]) {
  const evidence = acceptedSources.map((source) => source.relativeEvidencePath).join(", ") || "No accepted sources yet"
  return [
    `# ${topicSlug} Findings`,
    "",
    `## F001 ${slugify(input.finding.claim)}`,
    "",
    `- **Claim:** ${input.finding.claim}`,
    `- **Scope:** ${input.finding.scope}`,
    `- **Confidence:** ${input.finding.confidence}`,
    `- **Verified at:** ${input.updated}`,
    `- **Evidence:** ${evidence}`,
    `- **Notes:** ${input.finding.notes}`,
  ].join("\n")
}

function renderOpenQuestions(topicSlug: string, acceptedSources: AcceptedSource[]) {
  const caveats = acceptedSources.flatMap((source) => source.caveats)
  const questions = caveats.length > 0 ? caveats.map((caveat) => `- [ ] ${caveat}`) : ["- [ ] No unresolved questions recorded."]
  return [`# ${topicSlug} Open Questions`, "", "Track unresolved questions for this living topic directory.", "", "## Questions", "", ...questions].join("\n")
}

function renderSourcesIndex(topicSlug: string, acceptedSources: AcceptedSource[]) {
  const sourceLinks = acceptedSources.length > 0
    ? acceptedSources.map((source) => `- [${source.id}](${source.proposedType}/${source.id}-${slugify(source.title)}.md) — ${source.title}`)
    : ["- No accepted sources recorded yet."]

  return [
    `# ${topicSlug} Sources`,
    "",
    "Source records live under:",
    "",
    "```text",
    ".ncoworker/research/<topic>/sources/",
    "```",
    "",
    "Allowed source directories:",
    "",
    "- `web/` records use IDs like `W001`",
    "- `docs/` records use IDs like `D001`",
    "- `files/` records use IDs like `F001`",
    "",
    "## Accepted Sources",
    "",
    ...sourceLinks,
  ].join("\n")
}

function renderSourceRecord(source: AcceptedSource) {
  return [
    `# ${source.id} ${source.title}`,
    "",
    `- **ID:** ${source.id}`,
    `- **Type:** ${source.proposedType}`,
    `- **Title:** ${source.title}`,
    `- **URI/Path:** ${source.uriOrPath}`,
    `- **Retrieved at:** ${source.retrievedAt}`,
    `- **Reliability:** ${source.reliability}`,
    "- **Related findings:** F001",
    `- **Excerpt:** ${renderExcerpt(source)}`,
    `- **Notes:** ${renderSourceNotes(source)}`,
  ].join("\n")
}

function renderExcerpt(source: SourceNoteCandidate) {
  if (source.proposedType === "files") {
    return source.keyExcerpts[0] ?? "Reference-only file source metadata."
  }
  return source.keyExcerpts[0] ?? source.relevance
}

function renderSourceNotes(source: SourceNoteCandidate) {
  const parts = [...source.caveats]
  if (source.proposedType === "files") {
    parts.push("Reference-only metadata; original file content was not copied.")
  }
  if (source.contentHash) {
    parts.push(`Hash: ${source.contentHash}`)
  }
  return parts.join(" ") || source.relevance
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "research-topic"
}
