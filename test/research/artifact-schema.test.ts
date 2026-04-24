import { describe, expect, test } from "bun:test"
import {
  ALLOWED_FINDING_CONFIDENCE,
  ALLOWED_RESEARCH_STATUSES,
  ALLOWED_SOURCE_TYPES,
  FINDING_FIELDS,
  RESEARCH_ARTIFACT_PATHS,
  SOURCE_FIELDS,
  TOPIC_INDEX_FIELDS,
  researchArtifactFixtures,
  researchArtifactTemplates,
  validateFindingRecord,
  validateResearchIndex,
  validateSourceRecord,
  validateTopicIndex,
} from "./artifact-schema"

describe("research artifact schema", () => {
  test("defines the living research artifact path set", () => {
    expect(RESEARCH_ARTIFACT_PATHS).toEqual([
      ".ncoworker/research/index.md",
      ".ncoworker/research/<topic>/brief.md",
      ".ncoworker/research/<topic>/findings.md",
      ".ncoworker/research/<topic>/open-questions.md",
      ".ncoworker/research/<topic>/sources/index.md",
      ".ncoworker/research/<topic>/sources/web/W001-<slug>.md",
      ".ncoworker/research/<topic>/sources/docs/D001-<slug>.md",
      ".ncoworker/research/<topic>/sources/files/F001-<slug>.md",
    ])
    expect(RESEARCH_ARTIFACT_PATHS.some((path) => path.includes("<timestamp>"))).toBe(false)
  })

  test("defines exact topic, finding, and source field order", () => {
    expect(TOPIC_INDEX_FIELDS).toEqual(["Topic", "Title", "Summary", "Status", "Updated", "Tags"])
    expect(FINDING_FIELDS).toEqual(["Claim", "Scope", "Confidence", "Verified at", "Evidence", "Notes"])
    expect(SOURCE_FIELDS).toEqual([
      "ID",
      "Type",
      "Title",
      "URI/Path",
      "Retrieved at",
      "Reliability",
      "Related findings",
      "Excerpt",
      "Notes",
    ])
  })

  test("limits schema values to planned research artifact values", () => {
    expect(ALLOWED_RESEARCH_STATUSES).toEqual(["active", "stable", "stale", "archived"])
    expect(ALLOWED_FINDING_CONFIDENCE).toEqual(["high", "medium", "low"])
    expect(ALLOWED_SOURCE_TYPES).toEqual(["web", "docs", "files"])
  })

  test("defines exact Markdown templates for every research artifact", () => {
    expect(researchArtifactTemplates.workspaceIndex).toMatchSnapshot()
    expect(researchArtifactTemplates.topicBrief).toMatchSnapshot()
    expect(researchArtifactTemplates.topicFindings).toMatchSnapshot()
    expect(researchArtifactTemplates.topicOpenQuestions).toMatchSnapshot()
    expect(researchArtifactTemplates.sourcesIndex).toMatchSnapshot()
    expect(researchArtifactTemplates.webSource).toMatchSnapshot()
    expect(researchArtifactTemplates.docsSource).toMatchSnapshot()
    expect(researchArtifactTemplates.filesSource).toMatchSnapshot()
  })

  test("valid fixtures match the exact Markdown schemas", () => {
    expect(validateResearchIndex(researchArtifactFixtures.validWorkspaceIndex)).toEqual([])
    expect(validateTopicIndex(researchArtifactFixtures.validTopicBrief)).toEqual([])
    expect(validateFindingRecord(researchArtifactFixtures.validFindings)).toEqual([])
    expect(validateSourceRecord(".ncoworker/research/browser-security/sources/web/W001-csp-guide.md", researchArtifactFixtures.validWebSource)).toEqual([])
    expect(validateSourceRecord(".ncoworker/research/browser-security/sources/docs/D001-mdn-csp.md", researchArtifactFixtures.validDocsSource)).toEqual([])
    expect(validateSourceRecord(".ncoworker/research/browser-security/sources/files/F001-local-notes.md", researchArtifactFixtures.validFilesSource)).toEqual([])
  })

  test("rejects invalid topic index fields and values", () => {
    expect(validateTopicIndex(researchArtifactFixtures.invalidTopicBrief)).toEqual([
      "Expected topic index fields exactly: Topic, Title, Summary, Status, Updated, Tags",
      "Unsupported research status: pending",
      "Updated must use ISO date YYYY-MM-DD: 2026/04/25",
    ])
  })

  test("rejects unsupported code source records explicitly", () => {
    expect(
      validateSourceRecord(
        ".ncoworker/research/browser-security/sources/code/C001-parser.md",
        researchArtifactFixtures.invalidCodeSource,
      ),
    ).toEqual(["Unsupported source type: code. Allowed source types: web, docs, files"])
  })
})
