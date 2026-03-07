import { cp, mkdtemp } from "node:fs/promises"
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
    const permissions = createPermissionCoordinator({ write: "ask", edit: "ask", shell: "ask" })
    const registry = createToolRegistry([
      createWriteTool({ permissions }),
      createEditTool({ permissions }),
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

    permissions.resolve({ requestId: "permission_1", decision: "allow" })
    const result = await pending

    expect(result.output).toContain("notes.txt")
  })

  test("rejects edit when permission is denied", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissions = createPermissionCoordinator({ write: "ask", edit: "ask", shell: "ask" })
    const registry = createToolRegistry([createEditTool({ permissions })])

    const pending = registry.execute({
      toolName: "edit",
      args: { path: "README.md", oldText: "demo", newText: "live" },
      workspaceRoot,
    })

    permissions.resolve({ requestId: "permission_1", decision: "deny" })
    await expect(pending).rejects.toThrow("Permission denied")
  })

  test("runs shell in the workspace after permission is granted", async () => {
    const workspaceRoot = await createWorkspaceCopy()
    const permissions = createPermissionCoordinator({ write: "ask", edit: "ask", shell: "ask" })
    const registry = createToolRegistry([createShellTool({ permissions })])

    const pending = registry.execute({
      toolName: "shell",
      args: { command: "pwd" },
      workspaceRoot,
    })

    permissions.resolve({ requestId: "permission_1", decision: "allow" })
    const result = await pending

    expect(result.output).toContain("workspace")
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
