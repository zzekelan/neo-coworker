import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop sidebar", () => {
  test("projects only running, waiting_permission, and failed session states into badges", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain("const badge = getSessionStatusBadge(input.session.latestRunStatus, text)")
    expect(source).toContain("if (status === \"running\")")
    expect(source).toContain("label: text.sidebar.running")
    expect(source).toContain("if (status === \"waiting_permission\")")
    expect(source).toContain("label: text.sidebar.waiting")
    expect(source).toContain("if (status === \"failed\")")
    expect(source).toContain("label: text.sidebar.failed")
    expect(source).not.toContain("status === \"completed\"")
    expect(source).not.toContain("status === \"cancelled\"")
  })

  test("opens a session context menu on right click and explains busy-session delete blocking", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain("onContextMenu={input.onOpenContextMenu}")
    expect(source).toContain("setSessionContextMenu({")
    expect(source).toContain("text.sidebar.deleteSession")
    expect(source).toContain("text.sidebar.deleteBlocked")
    expect(source).toContain("text.sidebar.deleteHint")
    expect(source).toContain("status === \"queued\" || status === \"running\" || status === \"waiting_permission\"")
  })

  test("shows a settings entry wired to the desktop settings panel", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain("const [isSettingsOpen, setIsSettingsOpen] = useState(false)")
    expect(source).toContain("<SettingsPanel")
    expect(source).toContain("text.sidebar.settings")
    expect(source).toContain("settings.language === \"zh\" ? \"中文\" : \"EN\"")
  })
})
