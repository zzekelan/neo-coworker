import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  createGrepTool,
  createToolRuntimeApi,
} from "../../../src/tool"

function createRegistry() {
  return createToolRuntimeApi({
    tools: [createGrepTool()],
  })
}

describe("grep tool", () => {
  test("finds matching lines with pattern field", async () => {
    const registry = createRegistry()

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "helloDemo" },
      workspaceRoot: "test/fixtures/workspaces/read-search",
    })

    expect(result.output).toContain("src/demo.ts")
    expect(result.output).toContain("helloDemo")
  })

  test("rejects empty or whitespace-only patterns", async () => {
    const registry = createRegistry()

    await expect(
      registry.execute({
        toolName: "grep",
        args: { pattern: "   " },
        workspaceRoot: "test/fixtures/workspaces/read-search",
      }),
    ).rejects.toThrow()
  })

  test("skips reserved directories and caps matches", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-workspace-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await mkdir(join(workspaceRoot, ".agents"), { recursive: true })

    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(workspaceRoot, "src", `match-${index}.ts`), `const value = "manyHit"\n`)
    }

    await writeFile(join(workspaceRoot, ".agents", "hidden.ts"), 'const value = "manyHit"\n')

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "manyHit" },
      workspaceRoot,
    })

    expect(result.output).not.toContain(".agents/hidden.ts")
    expect(result.output).toContain("src/match-0.ts")
    expect(result.output).toContain("... truncated after 20 matches")
  })

  test("regex search: matches export function and export async function", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-regex-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "funcs.ts"), [
      "export function plainFunc() { return 1 }",
      "export async function asyncFunc() { return 2 }",
      "const arrow = () => 3",
    ].join("\n"))

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "export\\s+(async\\s+)?function", include: "*.ts", output_mode: "content" },
      workspaceRoot,
    })

    expect(result.output).toContain("plainFunc")
    expect(result.output).toContain("asyncFunc")
    expect(result.output).not.toContain("arrow")
  })

  test("output_mode files_with_matches: returns file paths without line content", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-files-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "a.ts"), "const ToolDefinition = true\n")
    await writeFile(join(workspaceRoot, "src", "b.ts"), "no match here\n")

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "ToolDefinition", output_mode: "files_with_matches" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/a.ts")
    expect(result.output).not.toContain("src/b.ts")
    expect(result.output).not.toMatch(/:\d+:/)
  })

  test("head_limit: caps results and appends truncation notice", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-headlimit-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    const lines = Array.from({ length: 20 }, (_, i) => `const val${i} = ${i}`)
    await writeFile(join(workspaceRoot, "src", "many.ts"), lines.join("\n"))

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "const", head_limit: 5, output_mode: "content" },
      workspaceRoot,
    })

    const matchLines = result.output.split("\n").filter((l) => l.includes("many.ts"))
    expect(matchLines.length).toBeLessThanOrEqual(5)
    expect(result.output).toMatch(/truncated|limit|5/)
  })

  test("caseSensitive false: matches regardless of case", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-case-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "cases.ts"), [
      "const HELLO = 'upper'",
      "const hello = 'lower'",
      "const Hello = 'mixed'",
    ].join("\n"))

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "hello", caseSensitive: false, output_mode: "content" },
      workspaceRoot,
    })

    expect(result.output).toContain("upper")
    expect(result.output).toContain("lower")
    expect(result.output).toContain("mixed")
  })

  test("caseSensitive true (default): only matches exact case", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-case-exact-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "cases.ts"), [
      "const HELLO = 'upper'",
      "const hello = 'lower'",
    ].join("\n"))

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "hello", output_mode: "content" },
      workspaceRoot,
    })

    expect(result.output).toContain("lower")
    expect(result.output).not.toContain("upper")
  })

  test("context lines: includes surrounding lines around matches", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-context-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "ctx.ts"), [
      "line before",
      "TARGET_MATCH",
      "line after",
    ].join("\n"))

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "TARGET_MATCH", context: 1, output_mode: "content" },
      workspaceRoot,
    })

    expect(result.output).toContain("TARGET_MATCH")
    expect(result.output).toContain("line before")
    expect(result.output).toContain("line after")
  })

  test("output_mode count: returns per-file match counts", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-count-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "multi.ts"), "needle\nneedle\nother\n")

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "needle", output_mode: "count" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/multi.ts")
    expect(result.output).toContain("2")
  })

  test("include filter: only searches files matching glob", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-include-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "a.ts"), "NEEDLE_TOKEN\n")
    await writeFile(join(workspaceRoot, "src", "b.js"), "NEEDLE_TOKEN\n")

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "NEEDLE_TOKEN", include: "*.ts", output_mode: "files_with_matches" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/a.ts")
    expect(result.output).not.toContain("src/b.js")
  })

  test("path filter: only searches files under the scoped subdirectory", async () => {
    const registry = createRegistry()
    const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-path-"))

    await mkdir(join(workspaceRoot, "src"), { recursive: true })
    await mkdir(join(workspaceRoot, "docs"), { recursive: true })
    await writeFile(join(workspaceRoot, "src", "inside.ts"), "SCOPED_NEEDLE\n")
    await writeFile(join(workspaceRoot, "docs", "outside.md"), "SCOPED_NEEDLE\n")

    const result = await registry.execute({
      toolName: "grep",
      args: { pattern: "SCOPED_NEEDLE", path: "src", output_mode: "files_with_matches" },
      workspaceRoot,
    })

    expect(result.output).toContain("src/inside.ts")
    expect(result.output).not.toContain("docs/outside.md")
  })

  test("tool definition has correct concurrency and isCompressible", () => {
    const tool = createGrepTool()
    expect(tool.concurrency).toBe("read-only")
    expect(tool.isCompressible).toBe(true)
  })
})
