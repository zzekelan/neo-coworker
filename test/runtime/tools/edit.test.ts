import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/permission"
import { createEditTool, createToolRuntimeApi } from "../../../src/tool"

function createAllowPermission() {
  const coordinator = createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" })
  return {
    requestPermission(input: { toolName: string; reason: string }) {
      return coordinator.request(input)
    },
  }
}

async function createTempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "edit-test-"))
  return dir
}

describe("edit tool — replaceAll option", () => {
  test("replaces all occurrences when replaceAll=true", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "file.txt")
    await writeFile(filePath, "oldName and oldName and oldName")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "file.txt", oldText: "oldName", newText: "newName", replaceAll: true },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("3")
    const content = await readFile(filePath, "utf8")
    expect(content).toBe("newName and newName and newName")
  })

  test("replaces all occurrences and reports count in output", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "multi.ts")
    await writeFile(filePath, "const x = 1\nconst x = 2\nconst x = 3\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "multi.ts", oldText: "const x", newText: "const y", replaceAll: true },
      workspaceRoot,
    })

    expect(result.output).toMatch(/3/)
    const content = await readFile(filePath, "utf8")
    expect(content).toBe("const y = 1\nconst y = 2\nconst y = 3\n")
  })
})

describe("edit tool — concurrent mutations", () => {
  test("serializes concurrent edits to the same file", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const filePath = join(workspaceRoot, "shared.txt")
    await writeFile(filePath, "alpha")

    let releaseFirstWrite!: () => void
    let signalFirstWriteStarted!: () => void
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve
    })

    const registry = createToolRuntimeApi({
      tools: [
        createEditTool({
          requestPermission,
          async atomicWrite(file, content) {
            if (file === filePath && content === "beta") {
              signalFirstWriteStarted()
              await new Promise<void>((resolve) => {
                releaseFirstWrite = resolve
              })
            }

            await writeFile(file, content, "utf8")
          },
        }),
      ],
    })

    const firstEdit = registry.execute({
      toolName: "edit",
      args: { path: "shared.txt", oldText: "alpha", newText: "beta" },
      workspaceRoot,
    })

    await firstWriteStarted

    const secondEdit = registry.execute({
      toolName: "edit",
      args: { path: "shared.txt", oldText: "beta", newText: "gamma" },
      workspaceRoot,
    })

    const secondStateBeforeRelease = await Promise.race([
      secondEdit.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ])

    expect(secondStateBeforeRelease).toBe("pending")

    releaseFirstWrite()

    const [firstResult, secondResult] = await Promise.all([firstEdit, secondEdit])
    expect(firstResult.isError).toBeFalsy()
    expect(secondResult.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("gamma")
  })

  test("does not block concurrent edits to different files", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const alphaPath = join(workspaceRoot, "alpha.txt")
    const betaPath = join(workspaceRoot, "beta.txt")
    await writeFile(alphaPath, "alpha")
    await writeFile(betaPath, "beta")

    let releaseAlphaWrite!: () => void
    let signalAlphaWriteStarted!: () => void
    let signalBetaWriteStarted!: () => void
    const alphaWriteStarted = new Promise<void>((resolve) => {
      signalAlphaWriteStarted = resolve
    })
    const betaWriteStarted = new Promise<void>((resolve) => {
      signalBetaWriteStarted = resolve
    })

    const registry = createToolRuntimeApi({
      tools: [
        createEditTool({
          requestPermission,
          async atomicWrite(file, content) {
            if (file === alphaPath && content === "ALPHA") {
              signalAlphaWriteStarted()
              await new Promise<void>((resolve) => {
                releaseAlphaWrite = resolve
              })
            }

            if (file === betaPath && content === "BETA") {
              signalBetaWriteStarted()
            }

            await writeFile(file, content, "utf8")
          },
        }),
      ],
    })

    const alphaEdit = registry.execute({
      toolName: "edit",
      args: { path: "alpha.txt", oldText: "alpha", newText: "ALPHA" },
      workspaceRoot,
    })

    await alphaWriteStarted

    const betaEdit = registry.execute({
      toolName: "edit",
      args: { path: "beta.txt", oldText: "beta", newText: "BETA" },
      workspaceRoot,
    })

    await betaWriteStarted

    const betaResult = await betaEdit
    expect(betaResult.isError).toBeFalsy()
    expect(await readFile(betaPath, "utf8")).toBe("BETA")

    releaseAlphaWrite()
    const alphaResult = await alphaEdit
    expect(alphaResult.isError).toBeFalsy()
    expect(await readFile(alphaPath, "utf8")).toBe("ALPHA")
  })

  test("releases the concurrent same-file lock after a failed mutation", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const filePath = join(workspaceRoot, "recover.txt")
    await writeFile(filePath, "start")

    let releaseFailedWrite!: () => void
    let signalFailedWriteStarted!: () => void
    const failedWriteStarted = new Promise<void>((resolve) => {
      signalFailedWriteStarted = resolve
    })

    const registry = createToolRuntimeApi({
      tools: [
        createEditTool({
          requestPermission,
          async atomicWrite(file, content) {
            if (file === filePath && content === "middle") {
              signalFailedWriteStarted()
              await new Promise<void>((resolve) => {
                releaseFailedWrite = resolve
              })
              throw new Error("simulated write failure")
            }

            await writeFile(file, content, "utf8")
          },
        }),
      ],
    })

    const firstEdit = registry.execute({
      toolName: "edit",
      args: { path: "recover.txt", oldText: "start", newText: "middle" },
      workspaceRoot,
    })

    await failedWriteStarted

    const secondEdit = registry.execute({
      toolName: "edit",
      args: { path: "recover.txt", oldText: "start", newText: "done" },
      workspaceRoot,
    })

    const secondStateBeforeRelease = await Promise.race([
      secondEdit.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ])

    expect(secondStateBeforeRelease).toBe("pending")

    releaseFailedWrite()

    await expect(firstEdit).rejects.toThrow("simulated write failure")

    const secondResult = await secondEdit
    expect(secondResult.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("done")
  })
})

describe("edit tool — multi-match protection", () => {
  test("returns isError=true when oldText appears multiple times without replaceAll", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "repeat.txt")
    await writeFile(filePath, "const x = 1\nconst x = 2\nconst x = 3\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "repeat.txt", oldText: "const x", newText: "const y" },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Found 3 matches")
  })

  test("returns match context (surrounding lines) when multi-match protection triggers", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "ctx.txt")
    await writeFile(filePath, "line1\nline2\nfoo\nline4\nline5\nfoo\nline7\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "ctx.txt", oldText: "foo", newText: "bar" },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Found 2 matches")
    expect(result.output).toContain("line2")
    expect(result.output).toContain("line4")
  })

  test("does not modify file when multi-match protection triggers", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "safe.txt")
    const original = "foo\nfoo\n"
    await writeFile(filePath, original)

    await registry.execute({
      toolName: "edit",
      args: { path: "safe.txt", oldText: "foo", newText: "bar" },
      workspaceRoot,
    })

    const content = await readFile(filePath, "utf8")
    expect(content).toBe(original)
  })

  test("succeeds with replaceAll=true when text appears multiple times", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "dup.txt")
    await writeFile(filePath, "foo\nfoo\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "dup.txt", oldText: "foo", newText: "bar", replaceAll: true },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    const content = await readFile(filePath, "utf8")
    expect(content).toBe("bar\nbar\n")
  })
})

describe("edit tool — max file size protection", () => {
  test("rejects edit when file exceeds 500KB", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "big.txt")
    const bigContent = "target\n" + "x".repeat(512 * 1024)
    await writeFile(filePath, bigContent)

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "big.txt", oldText: "target", newText: "replaced" },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/too large|500/i)
  })

  test("allows edit on file under 500KB", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "small.txt")
    await writeFile(filePath, "hello target world\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "small.txt", oldText: "target", newText: "replaced" },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
  })
})

describe("edit tool — match context return", () => {
  test("returns line number range of replacement in output", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "context.ts")
    const content = [
      "line 1",
      "line 2",
      "line 3",
      "const target = 'value'",
      "line 5",
      "line 6",
      "line 7",
    ].join("\n") + "\n"
    await writeFile(filePath, content)

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "context.ts", oldText: "const target = 'value'", newText: "const updated = 'new'" },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/lines? [0-9]+(?:-[0-9]+)?/i)
    expect(result.output).toContain("Updated lines")
  })

  test("includes surrounding context lines in successful replacement output", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "ctx.ts")
    const lines = [
      "before2",
      "before1",
      "MATCH_ME",
      "after1",
      "after2",
    ]
    await writeFile(filePath, lines.join("\n") + "\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "ctx.ts", oldText: "MATCH_ME", newText: "REPLACED" },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("Before:")
    expect(result.output).toContain("After:")
    expect(result.output).toContain("before1")
    expect(result.output).toContain("after1")
    expect(result.output).toContain("REPLACED")
  })

  test("includes before and after preview context for replaceAll output", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const registry = createToolRuntimeApi({
      tools: [createEditTool({ requestPermission })],
    })

    const filePath = join(workspaceRoot, "replace-all.ts")
    await writeFile(filePath, ["before", "target", "middle", "target", "after"].join("\n") + "\n")

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "replace-all.ts", oldText: "target", newText: "updated", replaceAll: true },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("Replaced 2 occurrences")
    expect(result.output).toContain("First replacement preview (before):")
    expect(result.output).toContain("First replacement preview (after):")
    expect(result.output).toContain("updated")
  })
})

describe("edit tool — schema and metadata", () => {
  test("has concurrency=mutating and isCompressible=false", () => {
    const { requestPermission } = createAllowPermission()
    const tool = createEditTool({ requestPermission })

    expect(tool.concurrency).toBe("mutating")
    expect(tool.isCompressible).toBe(false)
  })
})
