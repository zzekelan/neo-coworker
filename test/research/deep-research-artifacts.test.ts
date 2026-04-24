import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  validateFindingRecord,
  validateResearchIndex,
  validateSourceRecord,
  validateTopicIndex,
} from "./artifact-schema"
import {
  assertResearchArtifactPath,
  collectSourceNoteCandidate,
  readResearchTree,
  runPrimaryResearchArtifactWorkflow,
} from "./deep-research-artifacts"

async function createWorkspace() {
  return mkdtemp(join(tmpdir(), "ncoworker-research-artifacts-"))
}

describe("Deep Research artifact workflow", () => {
  test("primary workflow writes living-topic artifacts and converts accepted web source notes into finding evidence", async () => {
    const workspaceRoot = await createWorkspace()
    const sourceNote = collectSourceNoteCandidate({
      proposedType: "web",
      title: "Content Security Policy guide",
      uriOrPath: "https://example.com/csp-guide",
      retrievedAt: "2026-04-25",
      reliability: "Vendor-maintained security guide.",
      relevance: "Explains restrictive default-src behavior.",
      supports: ["A restrictive default-src reduces unexpected resource loading."],
      contradicts: [],
      keyExcerpts: ["default-src limits where resources can load from."],
      caveats: ["Recheck before citing in implementation work."],
      suggestedTags: ["browser", "security"],
      accepted: true,
    })

    const result = await runPrimaryResearchArtifactWorkflow(workspaceRoot, {
      topic: "Browser Security Headers",
      title: "Browser security headers",
      summary: "Current notes about content security policy and related headers.",
      updated: "2026-04-25",
      tags: ["browser", "security"],
      finding: {
        claim: "A restrictive default-src reduces unexpected resource loading.",
        scope: "Browser applications that serve user-visible HTML.",
        confidence: "high",
        notes: "Check framework-specific nonce handling before implementation.",
      },
      sourceNotes: [sourceNote],
    })

    expect(result.topicSlug).toBe("browser-security-headers")
    expect(result.writtenPaths).toEqual([
      ".ncoworker/research/index.md",
      ".ncoworker/research/browser-security-headers/brief.md",
      ".ncoworker/research/browser-security-headers/findings.md",
      ".ncoworker/research/browser-security-headers/open-questions.md",
      ".ncoworker/research/browser-security-headers/sources/index.md",
      ".ncoworker/research/browser-security-headers/sources/web/W001-content-security-policy-guide.md",
    ])

    const researchTree = await readResearchTree(workspaceRoot)
    expect(validateResearchIndex(researchTree[".ncoworker/research/index.md"])).toEqual([])
    expect(validateTopicIndex(researchTree[".ncoworker/research/browser-security-headers/brief.md"])).toEqual([])
    expect(validateFindingRecord(researchTree[".ncoworker/research/browser-security-headers/findings.md"])).toEqual([])
    expect(
      validateSourceRecord(
        ".ncoworker/research/browser-security-headers/sources/web/W001-content-security-policy-guide.md",
        researchTree[".ncoworker/research/browser-security-headers/sources/web/W001-content-security-policy-guide.md"],
      ),
    ).toEqual([])
    expect(researchTree[".ncoworker/research/browser-security-headers/findings.md"]).toContain(
      "- **Evidence:** sources/web/W001-content-security-policy-guide.md",
    )
    expect(researchTree[".ncoworker/research/index.md"]).toContain("browser-security-headers")
  })

  test("duplicate topic requests reuse the same living topic slug", async () => {
    const workspaceRoot = await createWorkspace()

    const first = await runPrimaryResearchArtifactWorkflow(workspaceRoot, {
      topic: "Browser Security Headers",
      title: "Browser security headers",
      summary: "Initial shared understanding.",
      updated: "2026-04-25",
      tags: ["browser"],
      finding: {
        claim: "CSP reduces unexpected resource loading.",
        scope: "Browser applications.",
        confidence: "medium",
        notes: "First pass.",
      },
      sourceNotes: [],
    })
    const second = await runPrimaryResearchArtifactWorkflow(workspaceRoot, {
      topic: "browser security headers",
      title: "Browser security headers",
      summary: "Updated shared understanding.",
      updated: "2026-04-25",
      tags: ["browser", "security"],
      finding: {
        claim: "CSP reduces unexpected resource loading.",
        scope: "Browser applications.",
        confidence: "medium",
        notes: "Second pass reuses the living topic.",
      },
      sourceNotes: [],
    })

    expect(second.topicSlug).toBe(first.topicSlug)
    expect(await readdir(join(workspaceRoot, ".ncoworker/research"))).toEqual(["browser-security-headers", "index.md"])
  })

  test("source-note subagent output is structured data only until the primary workflow writes artifacts", async () => {
    const workspaceRoot = await createWorkspace()

    const sourceNote = collectSourceNoteCandidate({
      proposedType: "docs",
      title: "MDN CSP",
      uriOrPath: "https://developer.mozilla.org/docs/Web/HTTP/CSP",
      retrievedAt: "2026-04-25",
      reliability: "Maintained reference documentation.",
      relevance: "Reference docs for CSP behavior.",
      supports: ["CSP controls resources the user agent may load."],
      contradicts: [],
      keyExcerpts: ["CSP controls resources the user agent may load."],
      caveats: ["Browser support tables are time-sensitive."],
      suggestedTags: ["docs"],
      accepted: true,
    })

    await expect(readResearchTree(workspaceRoot)).resolves.toEqual({})

    await runPrimaryResearchArtifactWorkflow(workspaceRoot, {
      topic: "Browser Security Headers",
      title: "Browser security headers",
      summary: "Current CSP notes.",
      updated: "2026-04-25",
      tags: ["browser"],
      finding: {
        claim: "CSP controls resources the user agent may load.",
        scope: "Browser applications.",
        confidence: "high",
        notes: "Converted from candidate notes by the primary workflow.",
      },
      sourceNotes: [sourceNote],
    })

    const researchTree = await readResearchTree(workspaceRoot)
    expect(Object.keys(researchTree)).toContain(
      ".ncoworker/research/browser-security-headers/sources/docs/D001-mdn-csp.md",
    )
  })

  test("file and PDF sources are reference-only metadata with path and hash, not copied content", async () => {
    const workspaceRoot = await createWorkspace()
    const pdfPath = join(workspaceRoot, "fixtures/local-security-notes.pdf")
    const pdfBody = "%PDF-1.4\nprivate source content that must not be copied"
    await mkdir(join(workspaceRoot, "fixtures"), { recursive: true })
    await writeFile(pdfPath, pdfBody)

    await runPrimaryResearchArtifactWorkflow(workspaceRoot, {
      topic: "Local Security Notes",
      title: "Local security notes",
      summary: "Reference-only notes from a local PDF.",
      updated: "2026-04-25",
      tags: ["files"],
      finding: {
        claim: "Existing app routes already emit partial CSP headers.",
        scope: "Local repository notes.",
        confidence: "low",
        notes: "Reference-only PDF metadata; original file stays outside research artifacts.",
      },
      sourceNotes: [
        collectSourceNoteCandidate({
          proposedType: "files",
          title: "Local security notes PDF",
          uriOrPath: pdfPath,
          retrievedAt: "2026-04-25",
          reliability: "Internal notes used as reference-only metadata.",
          relevance: "Mentions existing CSP headers.",
          supports: ["Existing app routes already emit partial CSP headers."],
          contradicts: [],
          keyExcerpts: ["Reference-only local PDF source."],
          caveats: ["Do not copy source file contents into research artifacts."],
          suggestedTags: ["files"],
          accepted: true,
          contentHash: "sha256-test-local-pdf",
        }),
      ],
    })

    const researchTree = await readResearchTree(workspaceRoot)
    const sourcePath = ".ncoworker/research/local-security-notes/sources/files/F001-local-security-notes-pdf.md"
    expect(validateSourceRecord(sourcePath, researchTree[sourcePath])).toEqual([])
    expect(researchTree[sourcePath]).toContain(`- **URI/Path:** ${pdfPath}`)
    expect(researchTree[sourcePath]).toContain("sha256-test-local-pdf")
    expect(Object.values(researchTree).join("\n")).not.toContain(pdfBody)
    expect(Object.keys(researchTree).some((path) => path.endsWith(".pdf"))).toBe(false)
    await expect(readFile(pdfPath, "utf8")).resolves.toBe(pdfBody)
  })

  test("artifact path guard rejects writes outside .ncoworker/research", () => {
    expect(assertResearchArtifactPath(".ncoworker/research/browser-security/brief.md")).toBe(
      ".ncoworker/research/browser-security/brief.md",
    )
    expect(() => assertResearchArtifactPath(".ncoworker/secret.md")).toThrow("outside .ncoworker/research")
    expect(() => assertResearchArtifactPath(".ncoworker/research/../secret.md")).toThrow("outside .ncoworker/research")
    expect(() => assertResearchArtifactPath("/tmp/.ncoworker/research/topic/brief.md")).toThrow(
      "workspace-relative",
    )
  })
})
