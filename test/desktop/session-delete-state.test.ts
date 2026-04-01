import { describe, expect, test } from "bun:test"
import { pickNextSessionIdAfterDelete } from "../../src/desktop/src/useDesktopApp"

describe("desktop session delete state", () => {
  test("selects the next most recent session after deleting the active one", () => {
    expect(
      pickNextSessionIdAfterDelete(
        [
          {
            id: "session-3",
            directory: "/workspace/alpha",
            workspaceRoot: "/workspace/alpha",
            createdAt: 3,
            title: "Latest",
            updatedAt: 30,
            latestUserMessagePreview: null,
            activeSkills: [],
            latestRunStatus: null,
          },
          {
            id: "session-2",
            directory: "/workspace/alpha",
            workspaceRoot: "/workspace/alpha",
            createdAt: 2,
            title: "Next",
            updatedAt: 20,
            latestUserMessagePreview: null,
            activeSkills: [],
            latestRunStatus: null,
          },
        ],
        "session-3",
      ),
    ).toBe("session-2")
  })

  test("returns null when deleting the last remaining session", () => {
    expect(
      pickNextSessionIdAfterDelete(
        [
          {
            id: "session-1",
            directory: "/workspace/alpha",
            workspaceRoot: "/workspace/alpha",
            createdAt: 1,
            title: "Only",
            updatedAt: 10,
            latestUserMessagePreview: null,
            activeSkills: [],
            latestRunStatus: null,
          },
        ],
        "session-1",
      ),
    ).toBeNull()
  })
})
