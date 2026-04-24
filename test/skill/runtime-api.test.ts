import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createWorkspaceSkillRuntime, createWorkspaceSkillStore } from "../../src/skill"

async function createWorkspaceWithSkill(input: {
  directoryName: string
  instructions: string
  skillsDirectory?: ".agents/skills" | ".ncoworker/skills"
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "skill-runtime-workspace-"))
  const skillsDirectory = input.skillsDirectory ?? ".ncoworker/skills"
  const skillDirectory = join(workspaceRoot, ...skillsDirectory.split("/"), input.directoryName)

  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, "SKILL.md"), input.instructions)

  return workspaceRoot
}

describe("skill runtime", () => {
  test("discovers skills from .ncoworker/skills by default", async () => {
    const workspaceRoot = await createWorkspaceWithSkill({
      directoryName: "reviewer",
      skillsDirectory: ".ncoworker/skills",
      instructions: [
        "name: reviewer",
        "description: Review code changes for regressions",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    })
    const runtime = createWorkspaceSkillRuntime()

    await expect(runtime.listCatalog(workspaceRoot)).resolves.toEqual([
      {
        name: "reviewer",
        description: "Review code changes for regressions",
        path: ".ncoworker/skills/reviewer/SKILL.md",
      },
    ])
  })

  test("ignores skills that exist only under legacy .agents/skills", async () => {
    const workspaceRoot = await createWorkspaceWithSkill({
      directoryName: "legacy-only",
      skillsDirectory: ".agents/skills",
      instructions: [
        "name: legacy-only",
        "description: Legacy skill should not load",
        "",
        "This should not be listed.",
      ].join("\n"),
    })
    const runtime = createWorkspaceSkillRuntime()

    await expect(runtime.listCatalog(workspaceRoot)).resolves.toEqual([])
    await expect(
      runtime.loadSkill({
        workspaceRoot,
        name: "legacy-only",
      }),
    ).rejects.toBeDefined()
  })

  test("discovers skill metadata without loading instructions", async () => {
    const runtime = createWorkspaceSkillRuntime()

    const catalog = await runtime.listCatalog("test/fixtures/workspaces/with-skill")

    expect(catalog).toEqual([
      {
        name: "reviewer",
        description: "Review code changes for bugs and regressions",
        path: ".ncoworker/skills/reviewer/SKILL.md",
      },
    ])
  })

  test("loads SKILL.md only on demand", async () => {
    const runtime = createWorkspaceSkillRuntime()

    const skill = await runtime.loadSkill({
      workspaceRoot: "test/fixtures/workspaces/with-skill",
      name: "reviewer",
    })

    expect(skill.name).toBe("reviewer")
    expect(skill.instructions).toContain("Focus on bugs first")
  })

  test("loads a skill by discovered name when front matter differs from directory name", async () => {
    const workspaceRoot = await createWorkspaceWithSkill({
      directoryName: "reviewer",
      instructions: [
        "name: strict-reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    })
    const runtime = createWorkspaceSkillRuntime()

    const [skill] = await runtime.listCatalog(workspaceRoot)
      expect(skill).toEqual({
      name: "strict-reviewer",
      description: "Review code changes carefully",
      path: ".ncoworker/skills/reviewer/SKILL.md",
    })

    const loaded = await runtime.loadSkill({
      workspaceRoot,
      name: "strict-reviewer",
    })

    expect(loaded).toMatchObject({
      name: "strict-reviewer",
      description: "Review code changes carefully",
      path: ".ncoworker/skills/reviewer/SKILL.md",
      entryPath: "SKILL.md",
      source: "workspace",
      files: [],
      instructions: expect.stringContaining("Focus on bugs first."),
    })
    expect(loaded.baseDir).toStartWith("file://")
  })

  test("skips broken skill symlinks while keeping the rest of the catalog readable", async () => {
    const workspaceRoot = await createWorkspaceWithSkill({
      directoryName: "reviewer",
      instructions: [
        "name: reviewer",
        "description: Review code changes for regressions",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    })
    const brokenSkillDirectory = join(workspaceRoot, ".ncoworker", "skills", "broken")

    await mkdir(brokenSkillDirectory, { recursive: true })
    await symlink(
      join(workspaceRoot, ".ncoworker", "skills", "broken", "missing-SKILL.md"),
      join(brokenSkillDirectory, "SKILL.md"),
    )

    const runtime = createWorkspaceSkillRuntime()

    await expect(runtime.listCatalog(workspaceRoot)).resolves.toEqual([
      {
        name: "reviewer",
        description: "Review code changes for regressions",
        path: ".ncoworker/skills/reviewer/SKILL.md",
      },
    ])
  })

  test("rejects discovered skill files that escape the skills directory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "skill-runtime-workspace-"))
    const externalRoot = await mkdtemp(join(tmpdir(), "skill-runtime-external-"))
    const skillDirectory = join(workspaceRoot, ".ncoworker", "skills", "reviewer")
    const externalSkillFile = join(externalRoot, "SKILL.md")

    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      externalSkillFile,
      ["name: reviewer", "description: Escapes the workspace", "", "Focus on bugs first."].join(
        "\n",
      ),
    )
    await symlink(externalSkillFile, join(skillDirectory, "SKILL.md"))

    const store = createWorkspaceSkillStore()
    await expect(store.listCatalog(workspaceRoot)).rejects.toThrow(
      "Skill must stay inside .ncoworker/skills",
    )
  })
})
