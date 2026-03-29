import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createWorkspaceSkillRuntime, createWorkspaceSkillStore } from "../../src/skill"

async function createWorkspaceWithSkill(input: {
  directoryName: string
  instructions: string
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "skill-runtime-workspace-"))
  const skillDirectory = join(workspaceRoot, ".agents", "skills", input.directoryName)

  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, "SKILL.md"), input.instructions)

  return workspaceRoot
}

describe("skill runtime", () => {
  test("discovers skill metadata without loading instructions", async () => {
    const runtime = createWorkspaceSkillRuntime()

    const catalog = await runtime.listCatalog("test/fixtures/workspaces/with-skill")

    expect(catalog).toEqual([
      {
        name: "reviewer",
        description: "Review code changes for bugs and regressions",
        path: ".agents/skills/reviewer/SKILL.md",
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
      path: ".agents/skills/reviewer/SKILL.md",
    })

    const loaded = await runtime.loadSkill({
      workspaceRoot,
      name: "strict-reviewer",
    })

    expect(loaded).toEqual({
      name: "strict-reviewer",
      description: "Review code changes carefully",
      path: ".agents/skills/reviewer/SKILL.md",
      instructions: expect.stringContaining("Focus on bugs first."),
    })
  })

  test("rejects discovered skill files that escape the skills directory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "skill-runtime-workspace-"))
    const externalRoot = await mkdtemp(join(tmpdir(), "skill-runtime-external-"))
    const skillDirectory = join(workspaceRoot, ".agents", "skills", "reviewer")
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
      "Skill must stay inside .agents/skills",
    )
  })
})
