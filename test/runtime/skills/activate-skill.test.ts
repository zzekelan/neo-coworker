import { describe, expect, test } from "bun:test"
import { discoverSkills } from "../../../src/runtime/skills/discover"
import { createActivateSkillTool } from "../../../src/runtime/tools/activate-skill"

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
})
