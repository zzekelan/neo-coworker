import { describe, expect, test } from "bun:test"
import {
  buildWorkspaceDirectory,
  hasVisibleWorkspaceSelect,
  inferWorkspaceParentDirectory,
} from "../../src/desktop/src/components/sidebar-workspace-state"

describe("desktop sidebar workspace state", () => {
  test("keeps the workspace select visible even before additional workspaces are loaded", () => {
    expect(hasVisibleWorkspaceSelect(0)).toBe(true)
    expect(hasVisibleWorkspaceSelect(1)).toBe(true)
  })

  test("derives the parent directory from a POSIX workspace root", () => {
    expect(inferWorkspaceParentDirectory("/tmp/demo-workspace")).toBe("/tmp")
    expect(inferWorkspaceParentDirectory("/demo-workspace")).toBe("/")
  })

  test("derives the parent directory from a Windows workspace root", () => {
    expect(inferWorkspaceParentDirectory("C:\\Users\\zlan\\demo", "win32")).toBe(
      "C:\\Users\\zlan",
    )
    expect(inferWorkspaceParentDirectory("C:\\demo", "win32")).toBe("C:")
  })

  test("builds a workspace directory from the parent directory and workspace name", () => {
    expect(
      buildWorkspaceDirectory({
        parentDirectory: "/tmp/projects",
        workspaceName: "alpha",
      }),
    ).toBe("/tmp/projects/alpha")
    expect(
      buildWorkspaceDirectory({
        parentDirectory: "C:\\Users\\zlan",
        workspaceName: "alpha",
        platform: "win32",
      }),
    ).toBe("C:\\Users\\zlan\\alpha")
  })

  test("rejects incomplete workspace create inputs", () => {
    expect(
      buildWorkspaceDirectory({
        parentDirectory: "",
        workspaceName: "alpha",
      }),
    ).toBeNull()
    expect(
      buildWorkspaceDirectory({
        parentDirectory: "/tmp/projects",
        workspaceName: " ",
      }),
    ).toBeNull()
  })
})
