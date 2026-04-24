import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { buildModelPromptSections } from "../../src/model"
import { createWorkspaceSkillRuntime, createWorkspaceSkillStore } from "../../src/skill"

async function createWorkspace() {
  return await mkdtemp(join(tmpdir(), "skill-package-workspace-"))
}

async function writePackageSkill(workspaceRoot: string) {
  const packageDirectory = join(workspaceRoot, ".ncoworker", "skills", "researcher")
  await mkdir(join(packageDirectory, "references"), { recursive: true })
  await mkdir(join(packageDirectory, "scripts"), { recursive: true })
  await mkdir(join(packageDirectory, "assets"), { recursive: true })
  await mkdir(join(packageDirectory, "examples", "nested"), { recursive: true })

  await writeFile(
    join(packageDirectory, "SKILL.md"),
    [
      "name: researcher",
      "description: Research with supporting package files",
      "",
      "Use package references only when explicitly requested.",
    ].join("\n"),
  )
  await writeFile(join(packageDirectory, "references", "guide.md"), "SECRET REFERENCE BODY")
  await writeFile(join(packageDirectory, "scripts", "collect.ts"), "console.log('secret script body')")
  await writeFile(join(packageDirectory, "assets", "diagram.svg"), "<svg>secret asset body</svg>")
  await writeFile(join(packageDirectory, "examples", "nested", "case.md"), "SECRET EXAMPLE BODY")

  return packageDirectory
}

describe("skill package loading", () => {
  test("loads SKILL.md with package metadata and package-relative support file paths", async () => {
    const workspaceRoot = await createWorkspace()
    const packageDirectory = await writePackageSkill(workspaceRoot)
    const runtime = createWorkspaceSkillRuntime()

    const skill = await runtime.loadSkill({ workspaceRoot, name: "researcher" })

    expect(skill).toMatchObject({
      name: "researcher",
      description: "Research with supporting package files",
      path: ".ncoworker/skills/researcher/SKILL.md",
      entryPath: "SKILL.md",
      baseDir: pathToFileURL(`${packageDirectory}/`).href,
      source: "workspace",
    })
    expect(skill.files).toEqual([
      "assets/diagram.svg",
      "examples/nested/case.md",
      "references/guide.md",
      "scripts/collect.ts",
    ])
    expect(skill.instructions).toContain("Use package references only when explicitly requested.")
    expect(skill.instructions).not.toContain("SECRET REFERENCE BODY")
    expect(skill.instructions).not.toContain("secret script body")
    expect(skill.instructions).not.toContain("secret asset body")
    expect(skill.instructions).not.toContain("SECRET EXAMPLE BODY")
  })

  test("projects active skill instructions without injecting support file bodies", async () => {
    const workspaceRoot = await createWorkspace()
    await writePackageSkill(workspaceRoot)
    const runtime = createWorkspaceSkillRuntime()
    const skill = await runtime.loadSkill({ workspaceRoot, name: "researcher" })

    const sections = buildModelPromptSections({
      systemPrompt: "base prompt",
      skillCatalog: [],
      activeSkills: [skill],
    })

    const rendered = sections.systemReminderMessages.join("\n\n")
    expect(rendered).toContain("Use package references only when explicitly requested.")
    expect(rendered).toContain("references/guide.md")
    expect(rendered).toContain("examples/nested/case.md")
    expect(rendered).not.toContain("SECRET REFERENCE BODY")
    expect(rendered).not.toContain("SECRET EXAMPLE BODY")
  })

  test("excludes support file symlinks that escape the skill package", async () => {
    const workspaceRoot = await createWorkspace()
    const packageDirectory = await writePackageSkill(workspaceRoot)
    const externalDirectory = await mkdtemp(join(tmpdir(), "skill-package-external-"))
    const externalFile = join(externalDirectory, "outside.md")
    await writeFile(externalFile, "outside package")
    await symlink(externalFile, join(packageDirectory, "references", "outside.md"))

    const runtime = createWorkspaceSkillRuntime()

    const skill = await runtime.loadSkill({ workspaceRoot, name: "researcher" })
    expect(skill.files).not.toContain("references/outside.md")
  })

  test("rejects explicit load paths that escape the workspace skill roots", async () => {
    const workspaceRoot = await createWorkspace()
    const externalDirectory = await mkdtemp(join(tmpdir(), "skill-package-external-"))
    const externalFile = join(externalDirectory, "outside.md")
    await writeFile(externalFile, "outside package")
    const escapedPath = relative(workspaceRoot, externalFile)

    const store = createWorkspaceSkillStore()

    await expect(store.loadByPath(workspaceRoot, escapedPath)).rejects.toThrow(
      "Skill must stay inside .ncoworker/skills or .agents/skills",
    )
  })

  test("rejects explicit load paths for support files inside a skill package", async () => {
    const workspaceRoot = await createWorkspace()
    await writePackageSkill(workspaceRoot)
    const store = createWorkspaceSkillStore()

    await expect(
      store.loadByPath(workspaceRoot, ".ncoworker/skills/researcher/references/guide.md"),
    ).rejects.toThrow("Skill entrypoint must be SKILL.md")
  })
})
