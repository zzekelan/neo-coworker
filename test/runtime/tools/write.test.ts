import { access, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/permission"
import { createToolRuntimeApi, createWriteTool } from "../../../src/tool"

function createAllowPermission() {
  const coordinator = createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" })
  return {
    requestPermission(input: { toolName: string; reason: string }) {
      return coordinator.request(input)
    },
  }
}

async function createTempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "write-test-"))
  return dir
}

describe("write tool — parent dir auto-creation", () => {
  test("creates parent directories that do not exist", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    const result = await registry.execute({
      toolName: "write",
      args: { path: "deep/nested/dir/file.txt", content: "hello" },
      workspaceRoot,
    })

    expect(result.output).toContain("deep/nested/dir/file.txt")
    const content = await readFile(join(workspaceRoot, "deep", "nested", "dir", "file.txt"), "utf8")
    expect(content).toBe("hello")
  })

  test("creates single level of missing parent directory", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await registry.execute({
      toolName: "write",
      args: { path: "subdir/file.txt", content: "world" },
      workspaceRoot,
    })

    const content = await readFile(join(workspaceRoot, "subdir", "file.txt"), "utf8")
    expect(content).toBe("world")
  })

  test("succeeds when parent dir already exists", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await registry.execute({
      toolName: "write",
      args: { path: "file.txt", content: "root level" },
      workspaceRoot,
    })

    const content = await readFile(join(workspaceRoot, "file.txt"), "utf8")
    expect(content).toBe("root level")
  })
})

describe("write tool — atomic write", () => {
  test("writes file content atomically (no partial content)", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    const largeContent = "A".repeat(100_000) + "\nEND"

    await registry.execute({
      toolName: "write",
      args: { path: "large.txt", content: largeContent },
      workspaceRoot,
    })

    const content = await readFile(join(workspaceRoot, "large.txt"), "utf8")
    expect(content).toBe(largeContent)
    expect(content.endsWith("\nEND")).toBe(true)
  })

  test("does not leave tmp file behind after successful write", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await registry.execute({
      toolName: "write",
      args: { path: "myfile.ts", content: "export const x = 1" },
      workspaceRoot,
    })

    const tmpPath = join(workspaceRoot, ".myfile.ts.tmp")
    await expect(access(tmpPath)).rejects.toThrow()
  })
})

describe("write tool — conditional overwrite protection", () => {
  test("allows overwrite for normal files", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await writeFile(join(workspaceRoot, "existing.txt"), "original content")

    const result = await registry.execute({
      toolName: "write",
      args: { path: "existing.txt", content: "new content" },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("existing.txt")
    expect(await readFile(join(workspaceRoot, "existing.txt"), "utf8")).toBe("new content")
  })

  test("returns isError=true with warning when a protected file already exists", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await writeFile(join(workspaceRoot, "README.md"), "original content")

    const result = await registry.execute({
      toolName: "write",
      args: { path: "README.md", content: "new content" },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("File exists")
    expect(result.output).toContain("read")
  })

  test("returns requiresRead=true in metadata when a protected file already exists", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await writeFile(join(workspaceRoot, "README.md"), "original content")

    const result = await registry.execute({
      toolName: "write",
      args: { path: "README.md", content: "new content" },
      workspaceRoot,
    })

    expect(result.metadata?.requiresRead).toBe(true)
  })

  test("does not overwrite protected file content when warning is returned", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    const original = "original content"
    await writeFile(join(workspaceRoot, "README.md"), original)

    await registry.execute({
      toolName: "write",
      args: { path: "README.md", content: "new content" },
      workspaceRoot,
    })

    const content = await readFile(join(workspaceRoot, "README.md"), "utf8")
    expect(content).toBe(original)
  })

  test("writes new file without warning", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    const result = await registry.execute({
      toolName: "write",
      args: { path: "brand-new.txt", content: "fresh content" },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("brand-new.txt")
  })
})

describe("write tool — schema and metadata", () => {
  test("has concurrency=mutating and isCompressible=false", () => {
    const { requestPermission } = createAllowPermission()
    const tool = createWriteTool({ requestPermission })

    expect(tool.concurrency).toBe("mutating")
    expect(tool.isCompressible).toBe(false)
  })
})
