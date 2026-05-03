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
    expect(source).toContain("import { isBusyRunStatus, shouldBlockSettingsApplyFromBusyState } from \"../busy-state\"")
    expect(source).toContain("disabled={isBusyRunStatus(contextMenuSession.latestRunStatus)}")
  })

  test("shows a settings entry wired to the desktop settings panel", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain("const [isSettingsOpen, setIsSettingsOpen] = useState(false)")
    expect(source).toContain("shouldBlockSettingsApplyFromBusyState")
    expect(source).toContain("hasAuthoritativeBusyState")
    expect(source).toContain("<SettingsPanel")
    expect(source).toContain("settings={settings}")
    expect(source).toContain("text.sidebar.settings")
  })

  test("keeps workspace dropdown visually light with breathing room before sessions", () => {
    const source = readFileSync("src/desktop/src/components/Sidebar.tsx", "utf8")

    expect(source).toContain('<section className="pb-5">')
    expect(source).toContain('<section className="flex min-h-0 flex-1 flex-col pt-5">')
    expect(source).toContain("rounded-lg border border-border bg-paper shadow-[0_12px_28px_rgba(18,17,14,0.12)]")
    expect(source).not.toContain("bg-paper shadow-xl backdrop-blur-sm transition-all duration-200")
  })
})
