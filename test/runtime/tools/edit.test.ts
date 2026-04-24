import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/permission"
import { createEditTool, createToolRuntimeApi } from "../../../src/tool"
import { formatAnchorLine } from "../../../src/tool/infrastructure/builtins/hash-anchor"

function createAllowPermission() {
  const coordinator = createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" })
  return {
    requestPermission(input: { toolName: string; reason: string }) {
      return coordinator.request(input)
    },
  }
}

async function createTempWorkspace() {
  return await mkdtemp(join(tmpdir(), "edit-test-"))
}

function anchor(lineNumber: number, lineContent: string) {
  return formatAnchorLine(lineNumber, lineContent)
}

async function createRegistry() {
  const { requestPermission } = createAllowPermission()
  return createToolRuntimeApi({
    tools: [createEditTool({ requestPermission })],
  })
}

describe("edit tool — anchored", () => {
  test("replaces a single anchored line", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "single.txt")
    await writeFile(filePath, "alpha\nbeta\ngamma\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "single.txt",
        operation: "replace",
        start: anchor(2, "beta"),
        content: "BETA",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("line 2")
    expect(await readFile(filePath, "utf8")).toBe("alpha\nBETA\ngamma\n")
  })

  test("replaces an inclusive anchored range", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "range.txt")
    await writeFile(filePath, "one\ntwo\nthree\nfour\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "range.txt",
        operation: "replace",
        start: anchor(2, "two"),
        end: anchor(3, "three"),
        content: "dos\ntres\n",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain("lines 2-3")
    expect(await readFile(filePath, "utf8")).toBe("one\ndos\ntres\nfour\n")
  })

  test("prepends content before the start anchor", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "prepend.txt")
    await writeFile(filePath, "first\nsecond\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "prepend.txt",
        operation: "prepend",
        start: anchor(2, "second"),
        content: "inserted\n",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("first\ninserted\nsecond\n")
  })

  test("appends content after the start anchor when end is omitted", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "append.txt")
    await writeFile(filePath, "first\nsecond\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "append.txt",
        operation: "append",
        start: anchor(1, "first"),
        content: "inserted\n",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("first\ninserted\nsecond\n")
  })

  test("appends content after the end anchor when provided", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "append-end.txt")
    await writeFile(filePath, "first\nsecond\nthird\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "append-end.txt",
        operation: "append",
        start: anchor(1, "first"),
        end: anchor(2, "second"),
        content: "inserted\n",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("first\nsecond\ninserted\nthird\n")
  })

  test("replaces a blank line using its anchor", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "blank.txt")
    await writeFile(filePath, "before\n\nafter\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "blank.txt",
        operation: "replace",
        start: anchor(2, ""),
        content: "between",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("before\nbetween\nafter\n")
  })

  test("targets duplicate displayed lines by line-numbered anchor", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "duplicate.txt")
    await writeFile(filePath, "repeat\nrepeat\nrepeat\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "duplicate.txt",
        operation: "replace",
        start: anchor(2, "repeat"),
        content: "middle",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("repeat\nmiddle\nrepeat\n")
  })

  test("preserves CRLF when inserting multi-line content", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "crlf.txt")
    await writeFile(filePath, "alpha\r\nbeta\r\ngamma\r\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "crlf.txt",
        operation: "append",
        start: anchor(1, "alpha"),
        content: "one\ntwo\n",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("alpha\r\none\r\ntwo\r\nbeta\r\ngamma\r\n")
  })

  test("retains the first-line BOM when editing later lines", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "bom.txt")
    await writeFile(filePath, "\uFEFFfirst\nsecond\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "bom.txt",
        operation: "replace",
        start: anchor(2, "second"),
        content: "SECOND",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("\uFEFFfirst\nSECOND\n")
  })

  test("retains the first-line BOM when replacing line 1", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "bom-first-line.txt")
    await writeFile(filePath, "\uFEFFfirst\nsecond\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "bom-first-line.txt",
        operation: "replace",
        start: anchor(1, "first"),
        content: "FIRST",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("\uFEFFFIRST\nsecond\n")
  })

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
      args: {
        path: "shared.txt",
        operation: "replace",
        start: anchor(1, "alpha"),
        content: "beta",
      },
      workspaceRoot,
    })

    await firstWriteStarted

    const secondEdit = registry.execute({
      toolName: "edit",
      args: {
        path: "shared.txt",
        operation: "replace",
        start: anchor(1, "beta"),
        content: "gamma",
      },
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
      args: {
        path: "alpha.txt",
        operation: "replace",
        start: anchor(1, "alpha"),
        content: "ALPHA",
      },
      workspaceRoot,
    })

    await alphaWriteStarted

    const betaEdit = registry.execute({
      toolName: "edit",
      args: {
        path: "beta.txt",
        operation: "replace",
        start: anchor(1, "beta"),
        content: "BETA",
      },
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
      args: {
        path: "recover.txt",
        operation: "replace",
        start: anchor(1, "start"),
        content: "middle",
      },
      workspaceRoot,
    })

    await failedWriteStarted

    const secondEdit = registry.execute({
      toolName: "edit",
      args: {
        path: "recover.txt",
        operation: "replace",
        start: anchor(1, "start"),
        content: "done",
      },
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

  test("serializes real-path and symlink-path mutations to the same underlying file", async () => {
    const workspaceRoot = await createTempWorkspace()
    const { requestPermission } = createAllowPermission()
    const realFilePath = join(workspaceRoot, "real.txt")
    await writeFile(realFilePath, "alpha")
    await mkdir(join(workspaceRoot, "links"), { recursive: true })
    await symlink(realFilePath, join(workspaceRoot, "links", "alias.txt"))

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
            if (file === realFilePath && content === "beta") {
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
      args: {
        path: "real.txt",
        operation: "replace",
        start: anchor(1, "alpha"),
        content: "beta",
      },
      workspaceRoot,
    })

    await firstWriteStarted

    const secondEdit = registry.execute({
      toolName: "edit",
      args: {
        path: "links/alias.txt",
        operation: "replace",
        start: anchor(1, "beta"),
        content: "gamma",
      },
      workspaceRoot,
    })

    const secondStateBeforeRelease = await Promise.race([
      secondEdit.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ])

    expect(secondStateBeforeRelease).toBe("pending")

    releaseFirstWrite()

    const [, secondResult] = await Promise.all([firstEdit, secondEdit])
    expect(secondResult.isError).toBeFalsy()
    expect(await readFile(realFilePath, "utf8")).toBe("gamma")
  })
})

describe("edit tool — stale", () => {
  test("returns isError=true when the start anchor hash is stale", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "stale.txt")
    const original = "alpha\nbeta\n"
    await writeFile(filePath, original)

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "stale.txt",
        operation: "replace",
        start: anchor(2, "old beta"),
        content: "BETA",
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Anchor hash mismatch")
    expect(await readFile(filePath, "utf8")).toBe(original)
  })

  test("returns isError=true for out-of-range anchors without changing bytes", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "range-error.txt")
    const original = "alpha\n"
    await writeFile(filePath, original)

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "range-error.txt",
        operation: "replace",
        start: anchor(2, "beta"),
        content: "BETA",
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("outside the available line range")
    expect(await readFile(filePath, "utf8")).toBe(original)
  })

  test("returns isError=true for reversed ranges without changing bytes", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "reversed.txt")
    const original = "one\ntwo\nthree\n"
    await writeFile(filePath, original)

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "reversed.txt",
        operation: "replace",
        start: anchor(3, "three"),
        end: anchor(2, "two"),
        content: "updated",
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Anchor range is reversed")
    expect(await readFile(filePath, "utf8")).toBe(original)
  })

  test("rejects legacy oldText/newText/replaceAll args as schema errors", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "legacy.txt")
    const original = "alpha\n"
    await writeFile(filePath, original)

    const result = await registry.execute({
      toolName: "edit",
      args: { path: "legacy.txt", oldText: "alpha", newText: "beta", replaceAll: true },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Unrecognized key")
    expect(await readFile(filePath, "utf8")).toBe(original)
  })

  test("rejects prepend when end is provided without changing bytes", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "prepend-end.txt")
    const original = "first\nsecond\n"
    await writeFile(filePath, original)

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "prepend-end.txt",
        operation: "prepend",
        start: anchor(1, "first"),
        end: anchor(2, "second"),
        content: "inserted\n",
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("does not accept an `end` anchor")
    expect(await readFile(filePath, "utf8")).toBe(original)
  })
})

describe("edit tool — max file size protection", () => {
  test("rejects edit when file exceeds 500KB", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "big.txt")
    const bigContent = "target\n" + "x".repeat(512 * 1024)
    await writeFile(filePath, bigContent)

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "big.txt",
        operation: "replace",
        start: anchor(1, "target"),
        content: "replaced",
      },
      workspaceRoot,
    })

    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/too large|500/i)
  })

  test("allows edit on file under 500KB", async () => {
    const workspaceRoot = await createTempWorkspace()
    const registry = await createRegistry()
    const filePath = join(workspaceRoot, "small.txt")
    await writeFile(filePath, "hello\ntarget\nworld\n")

    const result = await registry.execute({
      toolName: "edit",
      args: {
        path: "small.txt",
        operation: "replace",
        start: anchor(2, "target"),
        content: "replaced",
      },
      workspaceRoot,
    })

    expect(result.isError).toBeFalsy()
    expect(await readFile(filePath, "utf8")).toBe("hello\nreplaced\nworld\n")
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
