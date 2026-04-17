import { describe, expect, test } from "bun:test"
import {
  filterSkillCatalog,
  getEffectiveActiveSkills,
  getSkillActionState,
  toggleSkill,
} from "../../src/desktop/src/components/skill-state"

describe("desktop skill state", () => {
  test("filters skills against name, description, and path", () => {
    const filtered = filterSkillCatalog(
      [
        {
          name: "reviewer",
          description: "Review carefully",
          path: ".agents/skills/reviewer/SKILL.md",
        },
        {
          name: "writer",
          description: "Draft clearly",
          path: ".agents/skills/writer/SKILL.md",
        },
      ],
      "draft",
    )

    expect(filtered).toEqual([
      {
        name: "writer",
        description: "Draft clearly",
        path: ".agents/skills/writer/SKILL.md",
      },
    ])
  })

  test("derives effective active skills from the active run before session defaults", () => {
    expect(
      getEffectiveActiveSkills({
        session: {
          id: "session-1",
          title: "Demo",
          workspaceRoot: "/tmp/demo",
          sessionId: "session-1",
          updatedAt: new Date(0).toISOString(),
          activeSkills: ["writer"],
          latestRunStatus: null,
        },
        activeRun: {
          id: "run-1",
          sessionId: "session-1",
          status: "running",
          createdAt: new Date(0).toISOString(),
          activeSkills: ["reviewer"],
        },
      }),
    ).toEqual(["reviewer"])
  })

  test("computes start affordance from session and run state", () => {
    const session = {
      id: "session-1",
      title: "Demo",
      workspaceRoot: "/tmp/demo",
      sessionId: "session-1",
      updatedAt: new Date(0).toISOString(),
      activeSkills: ["writer"],
      latestRunStatus: null,
    }

    expect(
      getSkillActionState({
        skillName: "writer",
        session,
      }),
    ).toEqual({
      canStart: false,
      isActive: true,
    })

    expect(
      getSkillActionState({
        skillName: "reviewer",
        session,
        activeRun: {
          id: "run-1",
          sessionId: "session-1",
          status: "running",
          createdAt: new Date(0).toISOString(),
          activeSkills: ["reviewer"],
        },
      }),
    ).toEqual({
      canStart: false,
      isActive: true,
    })

    expect(
      getSkillActionState({
        skillName: "reviewer",
        session,
      }),
    ).toEqual({
      canStart: true,
      isActive: false,
    })
  })

  test("toggles skills without duplicating entries", () => {
    expect(toggleSkill({ skills: ["writer"], skillName: "reviewer", enabled: true })).toEqual([
      "writer",
      "reviewer",
    ])
    expect(toggleSkill({ skills: ["writer"], skillName: "writer", enabled: true })).toEqual([
      "writer",
    ])
    expect(
      toggleSkill({ skills: ["writer", "reviewer"], skillName: "writer", enabled: false }),
    ).toEqual(["reviewer"])
  })
})
