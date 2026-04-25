import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop deep-research real-path verifier script", () => {
  test("exposes the desktop:verify:deep-research script and guards the real Deep Research path", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>
    }
    const scriptSource = readFileSync("scripts/desktop-deep-research-verify.mjs", "utf8")

    expect(packageJson.scripts?.["desktop:verify:deep-research"]).toBe(
      "node ./scripts/desktop-deep-research-verify.mjs",
    )

    expect(scriptSource).toContain("import { _electron as electron } from \"playwright\"")
    expect(scriptSource).toContain("DESKTOP_DEEP_RESEARCH_VERIFY_PROMPT")
    expect(scriptSource).toContain("task-8-deep-research-real-path")
    expect(scriptSource).toContain("trace.zip")
    expect(scriptSource).toContain("screenshot.png")
    expect(scriptSource).toContain("session-summary.json")
    expect(scriptSource).toContain("lifecycle-summary.json")
    expect(scriptSource).toContain("transcript-summary.json")
    expect(scriptSource).toContain("sqlite-telemetry-summary.json")

    expect(scriptSource).toContain("DESKTOP_WORKSPACE_ROOT")
    expect(scriptSource).toContain("DESKTOP_SELECTION_STATE_PATH")
    expect(scriptSource).toContain("DESKTOP_SETTINGS_STATE_PATH")
    expect(scriptSource).toContain("NCOWORKER_SERVER_DB_PATH")
    expect(scriptSource).toContain("window.neoCoworkerDesktop.requestJson")
    expect(scriptSource).toContain("window.neoCoworkerDesktop.persistedWorkspaceRoot")
    expect(scriptSource).toContain("window.neoCoworkerDesktop.loadDesktopSettings")
    expect(scriptSource).toContain("page.context().tracing.start")
    expect(scriptSource).toContain("page.context().tracing.stop")

    expect(scriptSource).toContain("/agents/primary")
    expect(scriptSource).toContain("assertPrimaryAgentDisplayNames")
    expect(scriptSource).toContain("General")
    expect(scriptSource).toContain("Plan")
    expect(scriptSource).toContain("Deep Research")
    expect(scriptSource).toContain("source-researcher")
    expect(scriptSource).toContain("Source Researcher")
    expect(scriptSource).toContain("data-testid=\"agent-badge\"")
    expect(scriptSource).toContain("data-testid=\"agent-option-deep-research\"")
    expect(scriptSource).toContain("page.locator(\"textarea\")")
    expect(scriptSource).toContain("button[type=submit]")

    expect(scriptSource).toContain("readSqliteTelemetrySummary")
    expect(scriptSource).toContain("DatabaseSync")
    expect(scriptSource).toContain("FROM session")
    expect(scriptSource).toContain("FROM run_event")
    expect(scriptSource).toContain("FROM message")
    expect(scriptSource).toContain("FROM part")
    expect(scriptSource).toContain("parent_session_id")
    expect(scriptSource).toContain("tool.call.requested")
    expect(scriptSource).toContain("tool.call.completed")
    expect(scriptSource).toContain("skill.load.completed")
    expect(scriptSource).toContain("skill.load.failed")
    expect(scriptSource).toContain("subagent.started")
    expect(scriptSource).toContain("subagent.completed")

    expect(scriptSource).toContain("assertNoWorkspaceSkillFallback")
    expect(scriptSource).toContain(".ncoworker")
    expect(scriptSource).toContain("skills")
    expect(scriptSource).toContain("research")
    expect(scriptSource).toContain("source-note")
    expect(scriptSource).toContain("SKILL.md")
    expect(scriptSource).toContain("research/source-note")
    expect(scriptSource).toContain("ENOENT")
    expect(scriptSource).toContain("reasonable final output")
    expect(scriptSource).toContain('"create_skill"')
    expect(scriptSource).toContain('"patch_skill"')
    expect(scriptSource).toContain('"delete_skill"')
    expect(scriptSource).toContain("calledToolNames.has(operation) === false")

    expect(scriptSource).not.toContain("startMockModelServer")
    expect(scriptSource).not.toContain("fixtureProvider")
    expect(scriptSource).not.toContain("task-8-mock")
    expect(scriptSource).not.toContain('["create", "skill"].join("_")')
    expect(scriptSource).not.toContain('["patch", "skill"].join("_")')
  })
})
