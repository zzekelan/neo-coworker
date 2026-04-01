import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop sidebar", () => {
  test("projects only running, waiting_permission, and failed session states into badges", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain("const badge = getSessionStatusBadge(input.session.latestRunStatus)")
    expect(source).toContain("if (status === \"running\")")
    expect(source).toContain("label: \"Running\"")
    expect(source).toContain("if (status === \"waiting_permission\")")
    expect(source).toContain("label: \"Waiting\"")
    expect(source).toContain("if (status === \"failed\")")
    expect(source).toContain("label: \"Failed\"")
    expect(source).not.toContain("status === \"completed\"")
    expect(source).not.toContain("status === \"cancelled\"")
  })

  test("opens a session context menu on right click and explains busy-session delete blocking", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain("onContextMenu={input.onOpenContextMenu}")
    expect(source).toContain("setSessionContextMenu({")
    expect(source).toContain("Delete session")
    expect(source).toContain("Stop the active run before deleting this session.")
    expect(source).toContain("Deletes this session together with its transcript, runs, and trace history.")
    expect(source).toContain("status === \"queued\" || status === \"running\" || status === \"waiting_permission\"")
  })
})
