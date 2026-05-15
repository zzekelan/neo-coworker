import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/permission"
import { createApplyPatchTool, createBuiltinToolRuntime, createToolRuntimeApi } from "../../../src/tool"

async function createTempWorkspace() {
  return await mkdtemp(join(tmpdir(), "apply-patch-test-"))
}

function createPermissionState() {
  let lastRequestId: string | null = null
  let lastRequest: { toolName: string; reason: string } | null = null

  const permissions = createPermissionCoordinator(
    { apply_patch: "ask" },
    {
      onRequest(request) {
        lastRequestId = request.requestId
        lastRequest = {
          toolName: request.toolName,
          reason: request.reason,
        }
      },
    },
  )

  return {
    requestPermission(input: { toolName: string; reason: string }) {
      return permissions.request(input)
    },
    getLastRequest() {
      return lastRequest
    },
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

async function waitForPermissionRequest(
  permissionState: ReturnType<typeof createPermissionState>,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = permissionState.getLastRequest()
    if (request) {
      return request
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error("Timed out waiting for permission request")
}

describe("apply_patch tool", () => {
  test("is exposed by the builtin runtime as a JSON patchText tool", () => {
    const runtime = createBuiltinToolRuntime({
      requestPermission: async () => ({ decision: "allow" as const }),
    })

    const tool = runtime.list().find((entry) => entry.name === "apply_patch")

    expect(tool).toBeDefined()
    expect(tool?.description).toContain("patchText")
    expect(tool?.concurrency).toBe("mutating")
    expect(tool?.isCompressible).toBe(false)
  })

  test("updates one existing workspace file after apply_patch permission and returns a diff preview", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " alpha",
          "-beta",
          "+BETA",
          " gamma",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    const request = await waitForPermissionRequest(permissionState)
    const stateBeforePermission = await Promise.race([
      pending.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ])

    expect(stateBeforePermission).toBe("pending")
    expect(request).toEqual({
      toolName: "apply_patch",
      reason: "apply_patch notes.txt",
    })

    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("Applied patch to 1 file")
    expect(result.output).toContain("notes.txt")
    expect(result.output).toContain("-beta")
    expect(result.output).toContain("+BETA")
    expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma\n")
  })

  test("rejects empty patches before permission and leaves the workspace unchanged", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "alpha\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const result = await registry.execute({
      toolName: "apply_patch",
      args: { patchText: "   " },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Patch text must not be empty")
    expect(permissionState.getLastRequest()).toBeNull()
    expect(await readFile(filePath, "utf8")).toBe("alpha\n")
  })

  test("rejects missing update context before permission and leaves the workspace unchanged", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "alpha\nbeta\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const result = await registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          "-missing",
          "+present",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Patch context not found")
    expect(permissionState.getLastRequest()).toBeNull()
    expect(await readFile(filePath, "utf8")).toBe("alpha\nbeta\n")
  })

  test("adds a new file through the apply_patch path", async () => {
    const workspaceRoot = await createTempWorkspace()
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Add File: notes.txt",
          "+alpha",
          "+beta",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    const request = await waitForPermissionRequest(permissionState)
    expect(request).toEqual({
      toolName: "apply_patch",
      reason: "apply_patch notes.txt",
    })

    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("notes.txt (add, +2/-0)")
    expect(await readFile(join(workspaceRoot, "notes.txt"), "utf8")).toBe("alpha\nbeta\n")
  })

  test("add file patches may overwrite existing files", async () => {
    const workspaceRoot = await createTempWorkspace()
    await writeFile(join(workspaceRoot, "notes.txt"), "old\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Add File: notes.txt",
          "+new",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("notes.txt (add, +1/-0)")
    expect(result.output).toContain("-old")
    expect(result.output).toContain("+new")
    expect(await readFile(join(workspaceRoot, "notes.txt"), "utf8")).toBe("new\n")
  })

  test("deletes files through the apply_patch path", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "old\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Delete File: notes.txt",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    const request = await waitForPermissionRequest(permissionState)
    expect(request).toEqual({
      toolName: "apply_patch",
      reason: "apply_patch notes.txt",
    })

    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("notes.txt (delete, +0/-1)")
    await expect(access(filePath)).rejects.toThrow()
  })

  test("rejects directory deletion before permission", async () => {
    const workspaceRoot = await createTempWorkspace()
    const directoryPath = join(workspaceRoot, "notes")
    await mkdir(directoryPath)
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const result = await registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Delete File: notes",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("must be a file")
    expect(permissionState.getLastRequest()).toBeNull()
    await access(directoryPath)
  })

  test("moves files through the apply_patch path", async () => {
    const workspaceRoot = await createTempWorkspace()
    const sourcePath = join(workspaceRoot, "old.txt")
    const destinationPath = join(workspaceRoot, "renamed.txt")
    await writeFile(sourcePath, "same\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: old.txt",
          "*** Move to: renamed.txt",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    const request = await waitForPermissionRequest(permissionState)
    expect(request).toEqual({
      toolName: "apply_patch",
      reason: "apply_patch renamed.txt",
    })

    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("renamed.txt (move, +0/-0)")
    await expect(access(sourcePath)).rejects.toThrow()
    expect(await readFile(destinationPath, "utf8")).toBe("same\n")
  })

  test("move patches may overwrite existing destination files", async () => {
    const workspaceRoot = await createTempWorkspace()
    const sourcePath = join(workspaceRoot, "old.txt")
    const destinationPath = join(workspaceRoot, "renamed.txt")
    await writeFile(sourcePath, "source\n", "utf8")
    await writeFile(destinationPath, "destination\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: old.txt",
          "*** Move to: renamed.txt",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("rename from old.txt")
    expect(result.output).toContain("rename to renamed.txt")
    await expect(access(sourcePath)).rejects.toThrow()
    expect(await readFile(destinationPath, "utf8")).toBe("source\n")
  })

  test("matches update context with trailing whitespace differences", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "alpha  \nbeta\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " alpha",
          "-beta",
          "+BETA",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("alpha  \nBETA\n")
  })

  test("matches update context with leading and trailing whitespace differences", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "  alpha  \nbeta\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " alpha",
          "-beta",
          "+BETA",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("  alpha  \nBETA\n")
  })

  test("matches update context after normalizing common unicode punctuation and spaces", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "say “hello”\nold\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " say \"hello\"",
          "-old",
          "+new",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("say “hello”\nnew\n")
  })

  test("uses first-match behavior for repeated update context", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "item\nold\nitem\nold\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " item",
          "-old",
          "+new",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("item\nnew\nitem\nold\n")
  })

  test("end-of-file marked hunks prefer repeated context near the file tail", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "item\nold\nitem\nold\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " item",
          "-old",
          "+new",
          "*** End of File",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("item\nold\nitem\nnew\n")
  })

  test("preserves first-line BOM without fake BOM-only diff noise", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "\uFEFFfirst\nsecond\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " first",
          "-second",
          "+SECOND",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("\uFEFFfirst\nSECOND\n")
    expect(result.output).not.toContain("\uFEFFfirst")
  })

  test("writes updated files with LF line endings", async () => {
    const workspaceRoot = await createTempWorkspace()
    const filePath = join(workspaceRoot, "notes.txt")
    await writeFile(filePath, "alpha\r\nbeta\r\n", "utf8")
    const permissionState = createPermissionState()
    const registry = createToolRuntimeApi({
      tools: [createApplyPatchTool({ requestPermission: permissionState.requestPermission })],
    })

    const pending = registry.execute({
      toolName: "apply_patch",
      args: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: notes.txt",
          "@@",
          " alpha",
          "-beta",
          "+BETA",
          "*** End Patch",
          "",
        ].join("\n"),
      },
      workspaceRoot,
    })

    await waitForPermissionRequest(permissionState)
    permissionState.resolve("allow")
    const result = await pending

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\n")
  })
})
