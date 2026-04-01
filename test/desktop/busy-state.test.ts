import { describe, expect, test } from "bun:test"
import { isBusyRunStatus, shouldBlockSettingsApplyFromBusyState } from "../../src/desktop/src/busy-state"

describe("desktop busy state", () => {
  test("treats queued, running, and waiting_permission runs as busy", () => {
    expect(isBusyRunStatus("queued")).toBe(true)
    expect(isBusyRunStatus("running")).toBe(true)
    expect(isBusyRunStatus("waiting_permission")).toBe(true)
    expect(isBusyRunStatus("completed")).toBe(false)
    expect(isBusyRunStatus("failed")).toBe(false)
    expect(isBusyRunStatus("cancelled")).toBe(false)
    expect(isBusyRunStatus(null)).toBe(false)
  })

  test("blocks settings apply only when the busy summary is still authoritative", () => {
    const sessions = [{ latestRunStatus: "queued" as const }]
    const workspaces = [{ hasBusySession: true }]

    expect(
      shouldBlockSettingsApplyFromBusyState({
        hasAuthoritativeBusyState: true,
        sessions,
        workspaces,
      }),
    ).toBe(true)

    expect(
      shouldBlockSettingsApplyFromBusyState({
        hasAuthoritativeBusyState: false,
        sessions,
        workspaces,
      }),
    ).toBe(false)
  })
})
