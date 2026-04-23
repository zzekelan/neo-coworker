import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  HashAnchorError,
  detectEolStyle,
  formatAnchorLine,
  parseAnchor,
  splitLinesWithMetadata,
  validateInclusiveRange,
} from "../../../src/tool/infrastructure/builtins/hash-anchor"
import { createReadTool, createToolRuntimeApi } from "../../../src/tool"

function createRegistry() {
  return createToolRuntimeApi({
    tools: [createReadTool()],
  })
}

async function makeTmpWorkspace() {
  return mkdtemp(join(tmpdir(), "read-tool-test-"))
}

function expectHashAnchorError(fn: () => unknown, code: string) {
  try {
    fn()
    throw new Error(`Expected HashAnchorError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(HashAnchorError)
    expect((error as HashAnchorError).code).toBe(code)
  }
}

describe("read tool enhancements", () => {
  test("binary file detection: reading a .png returns a binary file notice without garbled content", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ])
    await writeFile(join(workspaceRoot, "image.png"), pngHeader)

    const result = await registry.execute({
      toolName: "read",
      args: { path: "image.png" },
      workspaceRoot,
    })

    expect(result.output.toLowerCase()).toContain("binary")
    expect(result.output).not.toMatch(/\x00/)
  })

  test("large file truncation: 3MB file is truncated with a hint, isError is not set", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    const line = "a".repeat(119) + "\n"
    const lines = Math.ceil((3 * 1024 * 1024) / line.length)
    const content = line.repeat(lines)
    await writeFile(join(workspaceRoot, "large.txt"), content)

    const result = await registry.execute({
      toolName: "read",
      args: { path: "large.txt" },
      workspaceRoot,
    })

    expect(result.output.length).toBeLessThan(2 * 1024 * 1024)
    expect(result.output.toLowerCase()).toMatch(/truncat/)
    expect(result.isError).toBeFalsy()
  })

  test("ENOENT friendly error: missing file returns structured tool error instead of throwing", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "read.ts"), "export {}\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: "src/raed.ts" },
      workspaceRoot,
    })

    expect(result).toEqual({
      output: "File not found: src/raed.ts. Check the path and try again.",
      isError: true,
    })
  })

  test("non-ENOENT resolution failures still propagate", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()
    const externalRoot = await makeTmpWorkspace()

    await mkdir(join(workspaceRoot, "links"), { recursive: true })
    await writeFile(join(externalRoot, "secret.txt"), "top secret\n")
    await symlink(join(externalRoot, "secret.txt"), join(workspaceRoot, "links", "secret.txt"))

    await expect(
      registry.execute({
        toolName: "read",
        args: { path: "links/secret.txt" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path must stay inside workspace")
  })

  test("line numbering: each line is prefixed with its 1-based line number", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await writeFile(join(workspaceRoot, "hello.txt"), "alpha\nbeta\ngamma\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: "hello.txt" },
      workspaceRoot,
    })

    expect(result.output).toContain("1: alpha")
    expect(result.output).toContain("2: beta")
    expect(result.output).toContain("3: gamma")
  })

  test("anchor helper formats canonical lines for visible content and blank lines", () => {
    expect(formatAnchorLine(1, "alpha")).toBe("L1#8ed3f6ad|alpha")
    expect(formatAnchorLine(2, "")).toBe("L2#e3b0c442|")
  })

  test("anchor helper keeps duplicate visible lines deterministic", () => {
    expect(formatAnchorLine(2, "same")).toBe("L2#0967115f|same")
    expect(formatAnchorLine(5, "same")).toBe("L5#0967115f|same")
  })

  test("anchor helper parses full anchor lines and validates inclusive ranges", () => {
    const lines = splitLinesWithMetadata("same\nsame\nbeta")
    const start = parseAnchor("L2#0967115f|same")
    const end = parseAnchor("L3#f44e64e7|beta")

    expect(start).toEqual({
      lineNumber: 2,
      hash: "0967115f",
      lineContent: "same",
    })
    expect(validateInclusiveRange(lines, start, end)).toEqual({
      startLineNumber: 2,
      endLineNumber: 3,
      startLineIndex: 1,
      endLineIndex: 2,
      lineCount: 2,
    })
  })

  test("anchor helper splits CRLF text and excludes first-line BOM from displayed content and hashes", () => {
    const text = "\ufeffalpha\r\n\r\nbeta\r\n"
    const lines = splitLinesWithMetadata(text)

    expect(detectEolStyle(text)).toBe("crlf")
    expect(lines).toEqual([
      {
        lineNumber: 1,
        rawContent: "\ufeffalpha",
        displayContent: "alpha",
        hasBom: true,
        lineEnding: "\r\n",
      },
      {
        lineNumber: 2,
        rawContent: "",
        displayContent: "",
        hasBom: false,
        lineEnding: "\r\n",
      },
      {
        lineNumber: 3,
        rawContent: "beta",
        displayContent: "beta",
        hasBom: false,
        lineEnding: "\r\n",
      },
    ])
    expect(formatAnchorLine(lines[0].lineNumber, lines[0].displayContent)).toBe("L1#8ed3f6ad|alpha")
  })

  test("malformed anchor strings are rejected with exact error codes", () => {
    expectHashAnchorError(() => parseAnchor("1: alpha"), "malformed_anchor")
    expectHashAnchorError(() => parseAnchor("Lx#abc|"), "malformed_anchor")
    expectHashAnchorError(() => parseAnchor("L3#1234567"), "malformed_anchor")
  })

  test("malformed anchor range validation rejects stale, out-of-range, and reversed anchors", () => {
    const lines = splitLinesWithMetadata("alpha\nbeta\n")

    expectHashAnchorError(
      () => validateInclusiveRange(lines, parseAnchor("L1#f44e64e7|beta")),
      "anchor_hash_mismatch",
    )
    expectHashAnchorError(
      () => validateInclusiveRange(lines, parseAnchor("L3#f44e64e7|beta")),
      "anchor_out_of_range",
    )
    expectHashAnchorError(
      () => validateInclusiveRange(lines, parseAnchor("L2#f44e64e7|beta"), parseAnchor("L1#8ed3f6ad|alpha")),
      "anchor_range_reversed",
    )
  })

  test("device path blocking: /dev/urandom is rejected with isError=true", async () => {
    const registry = createRegistry()

    const result = await registry.execute({
      toolName: "read",
      args: { path: "/dev/urandom" },
      workspaceRoot: "/tmp",
    }).catch(err => ({ output: err.message, isError: true as const }))

    expect(result.isError).toBe(true)
    expect(result.output.toLowerCase()).toMatch(/device|blocked|cannot read|forbidden/)
  })
})
