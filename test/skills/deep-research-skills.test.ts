import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildModelPromptSections } from "../../src/model"
import { createLayeredSkillRuntime, materializeBuiltinSkills } from "../../src/skill"

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true })
  }
})

describe("deep research built-in skills", () => {
  test("materializes all research skill packages with concise reference files", async () => {
    const xdgDataHome = await createTempDirectory("deep-research-skills-data-")

    await withEnv({ XDG_DATA_HOME: xdgDataHome }, async () => {
      const result = await materializeBuiltinSkills()
      const packages = result.packages.filter((pkg) => pkg.category === "research")

      expect(packages.map((pkg) => pkg.name)).toEqual([
        "deep-research",
        "finding-synthesis",
        "source-note",
      ])
      expect(packages.map((pkg) => pkg.entryPath)).toEqual([
        "research/deep-research/SKILL.md",
        "research/finding-synthesis/SKILL.md",
        "research/source-note/SKILL.md",
      ])

      for (const pkg of packages) {
        expect(pkg.files.map((file) => file.path)).toContain(`research/${pkg.name}/SKILL.md`)
      }

      expect(filePathsFor(packages, "deep-research")).toEqual([
        "research/deep-research/references/artifact-schema.md",
        "research/deep-research/references/finding-quality.md",
        "research/deep-research/references/source-note-schema.md",
        "research/deep-research/SKILL.md",
      ])
      expect(filePathsFor(packages, "source-note")).toEqual([
        "research/source-note/references/source-note-schema.md",
        "research/source-note/SKILL.md",
      ])
      expect(filePathsFor(packages, "finding-synthesis")).toEqual([
        "research/finding-synthesis/references/finding-quality.md",
        "research/finding-synthesis/SKILL.md",
      ])

      for (const pkg of packages) {
        const skillContent = await readFile(join(result.root, "research", pkg.name, "SKILL.md"), "utf8")

        expect(skillContent).toStartWith("---\n")
        expect(skillContent).toContain(`name: ${pkg.name}`)
        expect(skillContent).toContain("description:")
        expect(skillContent).toContain("version: 1")
        expect(skillContent).toContain("metadata:\n  category: research")
        expect(skillContent).toContain("  builtin: true")
        expect(skillContent).toContain("\n---\n\n")
      }

      const sourceNoteContent = await readFile(
        join(result.root, "research", "source-note", "SKILL.md"),
        "utf8",
      )
      expect(sourceNoteContent).toContain("Do not create skills")
      expect(sourceNoteContent).toContain("Do not write `.ncoworker/skills/**`")
      expect(sourceNoteContent).toContain("Do not fabricate sources")

      const artifactReference = await readFile(
        join(
          result.root,
          "research",
          "deep-research",
          "references",
          "artifact-schema.md",
        ),
        "utf8",
      )
      expect(artifactReference).toContain(".ncoworker/research/<topic>/findings.md")
      expect(artifactReference).toContain("Claim, Scope, Confidence, Verified at, Evidence, Notes")
      expect(artifactReference).toContain("ID, Type, Title, URI/Path, Retrieved at, Reliability, Related findings, Excerpt, Notes")
      expect(artifactReference).toContain("web, docs, files")
    })
  })

  test("loads activated research skills with reference paths but without reference bodies", async () => {
    const workspaceRoot = await createTempDirectory("deep-research-skills-workspace-")
    const xdgDataHome = await createTempDirectory("deep-research-skills-data-")

    await withEnv({ XDG_DATA_HOME: xdgDataHome }, async () => {
      const runtime = createLayeredSkillRuntime()
      const skill = await runtime.loadSkill({ workspaceRoot, name: "deep-research" })

      expect(skill).toMatchObject({
        name: "deep-research",
        description: "Plan and record file-based Deep Research artifacts",
        path: "builtin:research/deep-research/SKILL.md",
        entryPath: "SKILL.md",
        source: "builtin",
        files: [
          "references/artifact-schema.md",
          "references/finding-quality.md",
          "references/source-note-schema.md",
        ],
      })
      expect(skill.instructions).toContain("references/artifact-schema.md")
      expect(skill.instructions).toContain("metadata:\n  category: research")
      expect(skill.instructions).toContain("  scope: primary")
      expect(skill.instructions).not.toContain("Claim, Scope, Confidence, Verified at, Evidence, Notes")

      const sections = buildModelPromptSections({
        systemPrompt: "base prompt",
        skillCatalog: [],
        activeSkills: [skill],
      })
      const rendered = sections.systemReminderMessages.join("\n\n")
      const baseDirPath = fileURLToPath(skill.baseDir!)
      const sourceNoteSchemaPath = join(baseDirPath, "references", "source-note-schema.md")

      expect(rendered).toContain("Package files available on demand:")
      expect(rendered).toContain("references/artifact-schema.md")
      expect(rendered).toContain("references/source-note-schema.md")
      expect(rendered).toContain("references/finding-quality.md")
      expect(rendered).toContain(`Read path: ${sourceNoteSchemaPath}`)
      expect(sourceNoteSchemaPath).toContain(`${join("builtin-skills", "research", "deep-research", "references", "source-note-schema.md")}`)
      expect(rendered).not.toContain(`Read path: file://`)
      expect(rendered).not.toContain(`${join(".ncoworker", "skills", "research", "deep-research", "references", "source-note-schema.md")}`)
      expect(rendered).not.toContain("Claim, Scope, Confidence, Verified at, Evidence, Notes")
      expect(rendered).not.toContain("Store source notes with these exact fields")
      expect(rendered).not.toContain("Every finding needs evidence")
    })
  })
})

function filePathsFor(
  packages: Awaited<ReturnType<typeof materializeBuiltinSkills>>["packages"],
  name: string,
) {
  return packages.find((pkg) => pkg.name === name)!.files.map((file) => file.path)
}

async function createTempDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
