import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop running states harness", () => {
  test("exposes a dev-only query-param fixture without calling useAgent", () => {
    const appSource = readFileSync("src/desktop/src/App.tsx", "utf8")

    expect(appSource).toContain("shouldShowRunningStatesHarness()")
    expect(appSource).toContain('get("fixture") === "running-states"')
    expect(appSource).toContain("isLocalDesktopDevServer()")
    expect(appSource).toContain('window.location.port === "4173"')
    expect(appSource.indexOf("return <DesktopRunningStatesHarness />")).toBeLessThan(appSource.indexOf("useAgent()"))
  })

  test("keeps each long-running visual state available as a stable scenario", () => {
    const harnessSource = readFileSync("src/desktop/src/DesktopRunningStatesHarness.tsx", "utf8")

    expect(harnessSource).toContain('"thinking"')
    expect(harnessSource).toContain('"reasoning"')
    expect(harnessSource).toContain('"tool"')
    expect(harnessSource).toContain('"permission"')
    expect(harnessSource).toContain('"queued"')
    expect(harnessSource).toContain("activeRun: run")
    expect(harnessSource).toContain("permissionRequests: kind === \"permission\" ? [createPermissionRequest()] : []")
    expect(harnessSource).toContain("This path is dev-only and does not call the app-server.")
  })
})
