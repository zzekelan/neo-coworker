export const RESEARCH_ARTIFACT_PATHS = [
  ".ncoworker/research/index.md",
  ".ncoworker/research/<topic>/brief.md",
  ".ncoworker/research/<topic>/findings.md",
  ".ncoworker/research/<topic>/open-questions.md",
  ".ncoworker/research/<topic>/sources/index.md",
  ".ncoworker/research/<topic>/sources/web/W001-<slug>.md",
  ".ncoworker/research/<topic>/sources/docs/D001-<slug>.md",
  ".ncoworker/research/<topic>/sources/files/F001-<slug>.md",
] as const

export const TOPIC_INDEX_FIELDS = ["Topic", "Title", "Summary", "Status", "Updated", "Tags"] as const

export const FINDING_FIELDS = ["Claim", "Scope", "Confidence", "Verified at", "Evidence", "Notes"] as const

export const SOURCE_FIELDS = [
  "ID",
  "Type",
  "Title",
  "URI/Path",
  "Retrieved at",
  "Reliability",
  "Related findings",
  "Excerpt",
  "Notes",
] as const

export const ALLOWED_RESEARCH_STATUSES = ["active", "stable", "stale", "archived"] as const
export const ALLOWED_FINDING_CONFIDENCE = ["high", "medium", "low"] as const
export const ALLOWED_SOURCE_TYPES = ["web", "docs", "files"] as const

const topicIndexTemplate = [
  "# <topic> Research Brief",
  "",
  "- **Topic:** <topic>",
  "- **Title:** <title>",
  "- **Summary:** <one paragraph summary>",
  "- **Status:** active",
  "- **Updated:** YYYY-MM-DD",
  "- **Tags:** <tag>, <tag>",
  "",
  "## Brief",
  "",
  "Write the current shared understanding for this living topic directory.",
].join("\n")

const findingRecordTemplate = [
  "## F001 <short claim slug>",
  "",
  "- **Claim:** <testable claim>",
  "- **Scope:** <where the claim applies>",
  "- **Confidence:** medium",
  "- **Verified at:** YYYY-MM-DD",
  "- **Evidence:** <source IDs or paths>",
  "- **Notes:** <caveats or next checks>",
].join("\n")

function sourceRecordTemplate(id: string, type: (typeof ALLOWED_SOURCE_TYPES)[number], uriLabel: string) {
  return [
    `# ${id} <source title>`,
    "",
    `- **ID:** ${id}`,
    `- **Type:** ${type}`,
    "- **Title:** <source title>",
    `- **URI/Path:** ${uriLabel}`,
    "- **Retrieved at:** YYYY-MM-DD",
    "- **Reliability:** <why this source is reliable enough to cite>",
    "- **Related findings:** F001",
    "- **Excerpt:** <short quoted or summarized excerpt>",
    "- **Notes:** <limits, access notes, or follow-ups>",
  ].join("\n")
}

export const researchArtifactTemplates = {
  workspaceIndex: [
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
    "## Topic Records",
    "",
    topicIndexTemplate,
  ].join("\n"),
  topicBrief: topicIndexTemplate,
  topicFindings: [
    "# <topic> Findings",
    "",
    "Store durable findings as Markdown records with the exact field order below.",
    "",
    findingRecordTemplate,
  ].join("\n"),
  topicOpenQuestions: [
    "# <topic> Open Questions",
    "",
    "Track unresolved questions for this living topic directory.",
    "",
    "## Questions",
    "",
    "- [ ] <question>",
  ].join("\n"),
  sourcesIndex: [
    "# <topic> Sources",
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
  ].join("\n"),
  webSource: sourceRecordTemplate("W001", "web", "https://example.com/source"),
  docsSource: sourceRecordTemplate("D001", "docs", "https://docs.example.com/source"),
  filesSource: sourceRecordTemplate("F001", "files", "/absolute/or/workspace/path/to/source"),
} as const

export const researchArtifactFixtures = {
  validWorkspaceIndex: researchArtifactTemplates.workspaceIndex,
  validTopicBrief: [
    "# browser-security Research Brief",
    "",
    "- **Topic:** browser-security",
    "- **Title:** Browser security headers",
    "- **Summary:** Current notes about content security policy and related headers.",
    "- **Status:** active",
    "- **Updated:** 2026-04-25",
    "- **Tags:** browser, security",
    "",
    "## Brief",
    "",
    "Content security policy remains the primary active research area.",
  ].join("\n"),
  invalidTopicBrief: [
    "# browser-security Research Brief",
    "",
    "- **Topic:** browser-security",
    "- **Title:** Browser security headers",
    "- **Summary:** Current notes about content security policy.",
    "- **State:** pending",
    "- **Updated:** 2026/04/25",
    "- **Tags:** browser, security",
  ].join("\n"),
  validFindings: [
    "# browser-security Findings",
    "",
    "## F001 content-security-policy",
    "",
    "- **Claim:** A restrictive default-src reduces unexpected resource loading.",
    "- **Scope:** Browser applications that serve user-visible HTML.",
    "- **Confidence:** high",
    "- **Verified at:** 2026-04-25",
    "- **Evidence:** W001, D001, F001",
    "- **Notes:** Check framework-specific nonce handling before implementation.",
  ].join("\n"),
  validWebSource: [
    "# W001 Content Security Policy guide",
    "",
    "- **ID:** W001",
    "- **Type:** web",
    "- **Title:** Content Security Policy guide",
    "- **URI/Path:** https://example.com/csp-guide",
    "- **Retrieved at:** 2026-04-25",
    "- **Reliability:** Vendor-maintained security guide.",
    "- **Related findings:** F001",
    "- **Excerpt:** default-src limits where resources can load from.",
    "- **Notes:** Recheck before citing in implementation work.",
  ].join("\n"),
  validDocsSource: [
    "# D001 MDN CSP",
    "",
    "- **ID:** D001",
    "- **Type:** docs",
    "- **Title:** MDN Content Security Policy",
    "- **URI/Path:** https://developer.mozilla.org/docs/Web/HTTP/CSP",
    "- **Retrieved at:** 2026-04-25",
    "- **Reliability:** Maintained reference documentation.",
    "- **Related findings:** F001",
    "- **Excerpt:** CSP controls resources the user agent may load.",
    "- **Notes:** Treat browser support tables as time-sensitive.",
  ].join("\n"),
  validFilesSource: [
    "# F001 Local notes",
    "",
    "- **ID:** F001",
    "- **Type:** files",
    "- **Title:** Local security notes",
    "- **URI/Path:** docs/security/local-notes.md",
    "- **Retrieved at:** 2026-04-25",
    "- **Reliability:** Internal notes used as reference-only metadata.",
    "- **Related findings:** F001",
    "- **Excerpt:** Existing app routes already emit partial CSP headers.",
    "- **Notes:** Do not copy source file contents into research artifacts.",
  ].join("\n"),
  invalidCodeSource: [
    "# C001 Parser source",
    "",
    "- **ID:** C001",
    "- **Type:** code",
    "- **Title:** Parser source",
    "- **URI/Path:** src/parser.ts",
    "- **Retrieved at:** 2026-04-25",
    "- **Reliability:** Local source file.",
    "- **Related findings:** F001",
    "- **Excerpt:** Parser details.",
    "- **Notes:** Invalid source type fixture.",
  ].join("\n"),
} as const

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function extractFields(markdown: string) {
  const fields = new Map<string, string>()

  for (const line of markdown.split("\n")) {
    const match = line.match(/^- \*\*(.+?):\*\*\s*(.*)$/)
    if (match) {
      fields.set(match[1], match[2])
    }
  }

  return fields
}

function fieldNames(markdown: string) {
  return Array.from(extractFields(markdown).keys())
}

function hasExactFields(markdown: string, expectedFields: readonly string[]) {
  return JSON.stringify(fieldNames(markdown)) === JSON.stringify(expectedFields)
}

export function validateResearchIndex(markdown: string) {
  const errors: string[] = []

  for (const path of RESEARCH_ARTIFACT_PATHS) {
    if (!markdown.includes(path)) {
      errors.push(`Research index is missing path: ${path}`)
    }
  }

  return errors
}

export function validateTopicIndex(markdown: string) {
  const errors: string[] = []
  const fields = extractFields(markdown)

  if (!hasExactFields(markdown, TOPIC_INDEX_FIELDS)) {
    errors.push("Expected topic index fields exactly: Topic, Title, Summary, Status, Updated, Tags")
  }

  const status = fields.get("Status") ?? fields.get("State")
  if (status && !ALLOWED_RESEARCH_STATUSES.includes(status as (typeof ALLOWED_RESEARCH_STATUSES)[number])) {
    errors.push(`Unsupported research status: ${status}`)
  }

  const updated = fields.get("Updated")
  if (updated && !ISO_DATE_PATTERN.test(updated)) {
    errors.push(`Updated must use ISO date YYYY-MM-DD: ${updated}`)
  }

  return errors
}

export function validateFindingRecord(markdown: string) {
  const errors: string[] = []
  const fields = extractFields(markdown)

  if (!hasExactFields(markdown, FINDING_FIELDS)) {
    errors.push("Expected finding fields exactly: Claim, Scope, Confidence, Verified at, Evidence, Notes")
  }

  const confidence = fields.get("Confidence")
  if (confidence && !ALLOWED_FINDING_CONFIDENCE.includes(confidence as (typeof ALLOWED_FINDING_CONFIDENCE)[number])) {
    errors.push(`Unsupported finding confidence: ${confidence}`)
  }

  const verifiedAt = fields.get("Verified at")
  if (verifiedAt && !ISO_DATE_PATTERN.test(verifiedAt)) {
    errors.push(`Verified at must use ISO date YYYY-MM-DD: ${verifiedAt}`)
  }

  return errors
}

export function validateSourceRecord(path: string, markdown: string) {
  const sourceMatch = path.match(/\.ncoworker\/research\/[^/]+\/sources\/([^/]+)\/([A-Z]\d{3})-[^/]+\.md$/)
  const sourceTypeFromPath = sourceMatch?.[1]
  const idFromPath = sourceMatch?.[2]

  if (!isAllowedSourceType(sourceTypeFromPath)) {
    return [`Unsupported source type: ${sourceTypeFromPath ?? "unknown"}. Allowed source types: web, docs, files`]
  }

  const errors: string[] = []
  const fields = extractFields(markdown)

  if (!hasExactFields(markdown, SOURCE_FIELDS)) {
    errors.push("Expected source fields exactly: ID, Type, Title, URI/Path, Retrieved at, Reliability, Related findings, Excerpt, Notes")
  }

  const type = fields.get("Type")
  if (type !== sourceTypeFromPath) {
    errors.push(`Source Type must match path directory: ${sourceTypeFromPath}`)
  }

  const id = fields.get("ID")
  if (id !== idFromPath) {
    errors.push(`Source ID must match path prefix: ${idFromPath}`)
  }

  if (!id?.startsWith(sourcePrefixFor(sourceTypeFromPath))) {
    errors.push(`Source ID prefix must match source type: ${sourcePrefixFor(sourceTypeFromPath)}`)
  }

  const retrievedAt = fields.get("Retrieved at")
  if (retrievedAt && !ISO_DATE_PATTERN.test(retrievedAt)) {
    errors.push(`Retrieved at must use ISO date YYYY-MM-DD: ${retrievedAt}`)
  }

  return errors
}

function isAllowedSourceType(value: string | undefined): value is (typeof ALLOWED_SOURCE_TYPES)[number] {
  return ALLOWED_SOURCE_TYPES.includes(value as (typeof ALLOWED_SOURCE_TYPES)[number])
}

function sourcePrefixFor(type: (typeof ALLOWED_SOURCE_TYPES)[number]) {
  if (type === "web") {
    return "W"
  }
  if (type === "docs") {
    return "D"
  }
  return "F"
}
