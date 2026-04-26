import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createPermissionCoordinator } from "../../../src/permission"
import { materializeBuiltinSkills } from "../../../src/skill"
import {
  HashAnchorError,
  detectEolStyle,
  formatAnchorLine,
  parseAnchor,
  splitLinesWithMetadata,
  validateInclusiveRange,
} from "../../../src/tool/infrastructure/builtins/hash-anchor"
import { createEditTool, createReadTool, createToolRuntimeApi } from "../../../src/tool"

function createRegistry() {
  return createToolRuntimeApi({
    tools: [createReadTool()],
  })
}

function createAllowPermission() {
  const coordinator = createPermissionCoordinator({ write: "allow", edit: "allow", shell: "allow" })
  return {
    requestPermission(input: { toolName: string; reason: string }) {
      return coordinator.request(input)
    },
  }
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
  test("allows read-only access to materialized builtin skill reference paths", async () => {
    const workspaceRoot = await makeTmpWorkspace()
    const xdgDataHome = await makeTmpWorkspace()

    await withEnv({ XDG_DATA_HOME: xdgDataHome }, async () => {
      const materialized = await materializeBuiltinSkills()
      const referencePath = join(
        materialized.root,
        "research",
        "source-note",
        "references",
        "source-note-schema.md",
      )
      const { requestPermission } = createAllowPermission()
      const registry = createToolRuntimeApi({
        tools: [
          createReadTool(),
          createEditTool({ requestPermission }),
        ],
      })

      const result = await registry.execute({
        toolName: "read",
        args: { path: referencePath },
        workspaceRoot,
      })

      expect(result.output).toContain("Store source notes with these exact fields")

      await expect(
        registry.execute({
          toolName: "edit",
          args: {
            path: referencePath,
            operation: "replace",
            start: formatAnchorLine(1, "# Source note schema"),
            content: "blocked",
          },
          workspaceRoot,
        }),
      ).rejects.toThrow("Path must stay inside workspace")
    })
  })

  test("allows reading explicit .ncoworker/research artifacts while blocking runtime files", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await mkdir(join(workspaceRoot, ".ncoworker", "research", "browser-security"), { recursive: true })
    await writeFile(join(workspaceRoot, ".ncoworker", "research", "browser-security", "brief.md"), "# Brief\n")
    await writeFile(join(workspaceRoot, ".ncoworker", "secret.txt"), "secret\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: ".ncoworker/research/browser-security/brief.md" },
      workspaceRoot,
    })

    expect(result.output).toContain("# Brief")

    await expect(
      registry.execute({
        toolName: "read",
        args: { path: ".ncoworker/secret.txt" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path is reserved for agent runtime data")

    await expect(
      registry.execute({
        toolName: "read",
        args: { path: ".ncoworker/research/../secret.txt" },
        workspaceRoot,
      }),
    ).rejects.toThrow("Path is reserved for agent runtime data")
  })

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

    const visibleLine = "a".repeat(119)
    const line = `${visibleLine}\n`
    const lines = Math.ceil((3 * 1024 * 1024) / line.length)
    const content = line.repeat(lines)
    await writeFile(join(workspaceRoot, "large.txt"), content)

    const result = await registry.execute({
      toolName: "read",
      args: { path: "large.txt" },
      workspaceRoot,
    })

    expect(result.output.length).toBeLessThan(2 * 1024 * 1024)
    expect(result.output).toStartWith(formatAnchorLine(1, visibleLine))
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

  test("full-file reads emit anchored lines with visible line numbers", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await writeFile(join(workspaceRoot, "hello.txt"), "alpha\nbeta\ngamma\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: "hello.txt" },
      workspaceRoot,
    })

    expect(result.output).toBe([
      formatAnchorLine(1, "alpha"),
      formatAnchorLine(2, "beta"),
      formatAnchorLine(3, "gamma"),
    ].join("\n"))
  })

  test("offset and limit reads preserve anchored line numbering", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await writeFile(join(workspaceRoot, "window.txt"), "alpha\nbeta\ngamma\ndelta\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: "window.txt", offset: 2, limit: 2 },
      workspaceRoot,
    })

    expect(result.output).toBe([
      formatAnchorLine(2, "beta"),
      formatAnchorLine(3, "gamma"),
    ].join("\n"))
  })

  test("blank lines remain anchorable in read output", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await writeFile(join(workspaceRoot, "blank-lines.txt"), "alpha\n\nbeta\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: "blank-lines.txt" },
      workspaceRoot,
    })

    expect(result.output).toBe([
      formatAnchorLine(1, "alpha"),
      formatAnchorLine(2, ""),
      formatAnchorLine(3, "beta"),
    ].join("\n"))
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

  test("read uses anchored output for CRLF text and excludes first-line BOM from display and hash", async () => {
    const registry = createRegistry()
    const workspaceRoot = await makeTmpWorkspace()

    await writeFile(join(workspaceRoot, "bom-crlf.txt"), "\ufeffalpha\r\n\r\nbeta\r\n")

    const result = await registry.execute({
      toolName: "read",
      args: { path: "bom-crlf.txt" },
      workspaceRoot,
    })

    expect(result.output).toBe([
      formatAnchorLine(1, "alpha"),
      formatAnchorLine(2, ""),
      formatAnchorLine(3, "beta"),
    ].join("\n"))
  })

  test("read tool metadata documents the anchored output contract", () => {
    const tool = createReadTool()

    expect(tool.description).toContain("L{lineNumber}#{hash8}|{content}")
    expect(tool.usageGuidance).toContain("L...#hash")
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

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
  const previous = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}
