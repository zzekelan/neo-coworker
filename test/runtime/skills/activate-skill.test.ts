import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createActivateSkillTool, discoverSkills } from "../../../src/tool"

async function createWorkspaceWithSkill(input: {
  directoryName: string
  instructions: string
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "activate-skill-workspace-"))
  const skillDirectory = join(workspaceRoot, ".agents", "skills", input.directoryName)

  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, "SKILL.md"), input.instructions)

  return workspaceRoot
}

describe("skill activation", () => {
  test("discovers skill metadata without loading instructions", async () => {
    const catalog = await discoverSkills("test/fixtures/workspaces/with-skill")

    expect(catalog).toEqual([
      {
        name: "reviewer",
        description: "Review code changes for bugs and regressions",
        path: ".agents/skills/reviewer/SKILL.md",
      },
    ])
  })

  test("loads SKILL.md only on activation", async () => {
    const activeSkills: Array<{ name: string; instructions: string }> = []
    const tool = createActivateSkillTool({ activeSkills })

    const result = await tool.execute({
      args: { name: "reviewer" },
      workspaceRoot: "test/fixtures/workspaces/with-skill",
      toolName: "activate_skill",
    })

    expect(activeSkills).toHaveLength(1)
    expect(result.output).toContain("reviewer")
    expect(activeSkills[0]?.instructions).toContain("Focus on bugs first")
  })

  test("activates a skill by discovered name when front matter differs from directory name", async () => {
    const workspaceRoot = await createWorkspaceWithSkill({
      directoryName: "reviewer",
      instructions: [
        "name: strict-reviewer",
        "description: Review code changes carefully",
        "",
        "Focus on bugs first.",
      ].join("\n"),
    })
    const activeSkills: Array<{ name: string; instructions: string }> = []
    const tool = createActivateSkillTool({ activeSkills })
    const [skill] = await discoverSkills(workspaceRoot)

    expect(skill).toEqual({
      name: "strict-reviewer",
      description: "Review code changes carefully",
      path: ".agents/skills/reviewer/SKILL.md",
    })

    const result = await tool.execute({
      args: { name: "strict-reviewer" },
      workspaceRoot,
      toolName: "activate_skill",
    })

    expect(result.output).toContain("strict-reviewer")
    expect(activeSkills).toEqual([
      {
        name: "strict-reviewer",
        instructions: expect.stringContaining("Focus on bugs first."),
      },
    ])
  })

  test("rejects discovered skill files that escape the skills directory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "activate-skill-workspace-"))
    const externalRoot = await mkdtemp(join(tmpdir(), "activate-skill-external-"))
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

    await expect(discoverSkills(workspaceRoot)).rejects.toThrow(
      "Skill must stay inside .agents/skills",
    )
  })
})
