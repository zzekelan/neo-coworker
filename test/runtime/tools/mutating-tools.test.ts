import { cp, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/runtime/permissions"
import { createEditTool } from "../../../src/runtime/tools/edit"
import { createToolRegistry } from "../../../src/runtime/tools/registry"
import { createShellTool } from "../../../src/runtime/tools/shell"
import { createWriteTool } from "../../../src/runtime/tools/write"

async function createWorkspaceCopy() {
  const tempRoot = await mkdtemp(join(tmpdir(), "mutating-tools-"))
  const workspaceRoot = join(tempRoot, "workspace")

  await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })

  return workspaceRoot
}

describe("mutating tools", () => {
  test("blocks write until permission is granted", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([
      createWriteTool({ permissions: permissionState.permissions }),
      createEditTool({ permissions: permissionState.permissions }),
    ])

    const pending = registry.execute({
      toolName: "write",
      args: { path: "notes.txt", content: "hello" },
      workspaceRoot,
    })

    const stateBeforePermission = await Promise.race([
      pending.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ])

    expect(stateBeforePermission).toBe("pending")

    permissionState.resolve("allow")
    const result = await pending

    expect(result.output).toContain("notes.txt")
  })

  test("rejects edit when permission is denied", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([createEditTool({ permissions: permissionState.permissions })])

    const pending = registry.execute({
      toolName: "edit",
      args: { path: "README.md", oldText: "demo", newText: "live" },
      workspaceRoot,
    })

    permissionState.resolve("deny")
    await expect(pending).rejects.toThrow("Permission denied")
  })

  test("rejects edit when target text appears multiple times", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([createEditTool({ permissions: permissionState.permissions })])
    const repeatedFile = join(workspaceRoot, "src", "repeat.txt")

    await writeFile(repeatedFile, "demo demo\n")

    const pending = registry.execute({
      toolName: "edit",
      args: { path: "src/repeat.txt", oldText: "demo", newText: "live" },
      workspaceRoot,
    })

    permissionState.resolve("allow")

    await expect(pending).rejects.toThrow("Target text must appear exactly once")
    expect(await Bun.file(repeatedFile).text()).toBe("demo demo\n")
  })

  test("rejects edit when target text has overlapping duplicate matches", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([createEditTool({ permissions: permissionState.permissions })])
    const overlappingFile = join(workspaceRoot, "src", "overlap.txt")

    await writeFile(overlappingFile, "ababa\n")

    const pending = registry.execute({
      toolName: "edit",
      args: { path: "src/overlap.txt", oldText: "aba", newText: "xyz" },
      workspaceRoot,
    })

    permissionState.resolve("allow")

    await expect(pending).rejects.toThrow("Target text must appear exactly once")
    expect(await Bun.file(overlappingFile).text()).toBe("ababa\n")
  })

  test("runs shell in the workspace after permission is granted", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([createShellTool({ permissions: permissionState.permissions })])

    const pending = registry.execute({
      toolName: "shell",
      args: { command: "pwd" },
      workspaceRoot,
    })

    permissionState.resolve("allow")
    const result = await pending

    expect(result.output).toContain("workspace")
  })

  test("describes shell as running with the workspace as the current directory", () => {
    const tool = createShellTool({
      permissions: createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" }),
    })

    expect(tool.description).toBe("Run a shell command with the workspace as the current directory")
  })

  test("rejects shell when permission is denied", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([createShellTool({ permissions: permissionState.permissions })])

    const pending = registry.execute({
      toolName: "shell",
      args: { command: "pwd" },
      workspaceRoot,
    })

    permissionState.resolve("deny")

    await expect(pending).rejects.toThrow("Permission denied")
  })

  test("surfaces shell non-zero exits after permission is granted", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissionState = createPermissionState()
    const registry = createToolRegistry([createShellTool({ permissions: permissionState.permissions })])

    const pending = registry.execute({
      toolName: "shell",
      args: { command: "exit 7" },
      workspaceRoot,
    })

    permissionState.resolve("allow")

    await expect(pending).rejects.toThrow("Shell command failed with exit code 7")
  })

  test("rejects duplicate tool names in the registry", () => {
    expect(() =>
      createToolRegistry([
        createWriteTool({
          permissions: createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" }),
        }),
        createWriteTool({
          permissions: createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" }),
        }),
      ]),
    ).toThrow("Duplicate tool: write")
  })
})

function createPermissionState() {
  let lastRequestId: string | null = null

  const permissions = createPermissionCoordinator(
    { write: "ask", edit: "ask", shell: "ask" },
    {
      onRequest(request) {
        lastRequestId = request.requestId
      },
    },
  )

  return {
    permissions,
    resolve(decision: "allow" | "deny") {
      if (!lastRequestId) {
        throw new Error("Expected a pending permission request")
      }

      permissions.resolve({
        requestId: lastRequestId,
        decision,
      })
    },
  }
}
