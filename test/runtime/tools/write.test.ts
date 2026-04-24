import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/permission"
import { createToolRuntimeApi, createWriteTool } from "../../../src/tool"
import { writeUtf8FileAtomically } from "../../../src/tool/infrastructure/builtins/mutating-file"

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
  test("allows writes under .ncoworker/research while blocking unrelated runtime files", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    const result = await registry.execute({
      toolName: "write",
      args: { path: ".ncoworker/research/browser-security/brief.md", content: "# Brief\n" },
      workspaceRoot,
    })

    expect(result.output).toContain(".ncoworker/research/browser-security/brief.md")
    expect(await readFile(join(workspaceRoot, ".ncoworker", "research", "browser-security", "brief.md"), "utf8")).toBe("# Brief\n")

    await expect(
      registry.execute({
        toolName: "write",
        args: { path: ".ncoworker/secret.txt", content: "blocked" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path is reserved for agent runtime data")

    await expect(
      registry.execute({
        toolName: "write",
        args: { path: ".ncoworker/research/../secret.txt", content: "blocked" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path is reserved for agent runtime data")
  })

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

    const directoryEntries = (await readdir(workspaceRoot)).join("\n")
    expect(directoryEntries).not.toContain(".myfile.ts.tmp")
  })

  test("uses a same-directory unique temp file and cleans it up after atomic rename failure", async () => {
    const workspaceRoot = await createTempWorkspace()
    const targetPath = join(workspaceRoot, "nested", "atomic.txt")
    let observedTempPath: string | undefined

    await expect(
      writeUtf8FileAtomically(targetPath, "atomic content", {
        async writeTempFile(tempPath, content) {
          observedTempPath = tempPath
          await writeFile(tempPath, content, "utf8")
        },
        async renameFile(from, to) {
          expect(from).toBe(observedTempPath)
          expect(to).toBe(targetPath)
          expect(await readFile(from, "utf8")).toBe("atomic content")
          throw new Error("rename failed")
        },
      }),
    ).rejects.toThrow("rename failed")

    expect(observedTempPath).toBeDefined()
    expect(dirname(observedTempPath!)).toBe(dirname(targetPath))
    expect(basename(observedTempPath!)).toMatch(/^\.atomic\.txt\.tmp\.[^.]+(?:-.+)?$/)
    await expect(access(observedTempPath!)).rejects.toThrow()
    await expect(access(targetPath)).rejects.toThrow()
  })

  test("preserves existing file mode when atomically overwriting", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })
    const filePath = join(workspaceRoot, "script.sh")

    await writeFile(filePath, "#!/bin/sh\necho old\n", "utf8")
    await chmod(filePath, 0o700)

    await registry.execute({
      toolName: "write",
      args: { path: "script.sh", content: "#!/bin/sh\necho new\n" },
      workspaceRoot,
    })

    expect((await lstat(filePath)).mode & 0o777).toBe(0o700)
  })

  test("rejects writes through symlinked parents that escape the workspace", async () => {
    const workspaceRoot = await createTempWorkspace()
    const externalRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await mkdir(join(workspaceRoot, "links"), { recursive: true })
    await symlink(externalRoot, join(workspaceRoot, "links", "outside"))

    await expect(
      registry.execute({
        toolName: "write",
        args: { path: "links/outside/escape.txt", content: "nope" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path must stay inside workspace")

    await expect(access(join(externalRoot, "escape.txt"))).rejects.toThrow()
  })

  test("rejects writes through symlinked parents into reserved runtime directories", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createWriteTool({ requestPermission })],
    })

    await mkdir(join(workspaceRoot, ".ncoworker"), { recursive: true })
    await mkdir(join(workspaceRoot, "links"), { recursive: true })
    await symlink(join(workspaceRoot, ".ncoworker"), join(workspaceRoot, "links", "runtime"))

    await expect(
      registry.execute({
        toolName: "write",
        args: { path: "links/runtime/secret.txt", content: "blocked" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path is reserved for agent runtime data")
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
