import { describe, expect, test } from "bun:test"
import { canParallelize, ParallelizationClass, TOOL_PARALLELIZATION_DEFAULTS } from "../../src/tool"

describe("tool parallelization domain", () => {
  test("exports builtin classifications for runtime tool names", () => {
    expect(TOOL_PARALLELIZATION_DEFAULTS.shell?.classification).toBe(ParallelizationClass.NEVER_PARALLEL)
    expect(TOOL_PARALLELIZATION_DEFAULTS.read?.classification).toBe(ParallelizationClass.PARALLEL_SAFE)
    expect(TOOL_PARALLELIZATION_DEFAULTS.write?.classification).toBe(ParallelizationClass.PATH_SCOPED)
    expect(TOOL_PARALLELIZATION_DEFAULTS.edit?.classification).toBe(ParallelizationClass.PATH_SCOPED)
  })

  test("never-parallel tools always run alone", () => {
    const batches = canParallelize([
      { name: "read", args: { path: "alpha.ts" } },
      { name: "shell", args: { command: "pwd" } },
      { name: "glob", args: { pattern: "**/*.ts" } },
    ])

    expect(batches).toEqual([
      [{ name: "read", args: { path: "alpha.ts" } }],
      [{ name: "shell", args: { command: "pwd" } }],
      [{ name: "glob", args: { pattern: "**/*.ts" } }],
    ])
  })

  test("parallel-safe tools are grouped together", () => {
    const batches = canParallelize([
      { name: "read", args: { path: "alpha.ts" } },
      { name: "glob", args: { pattern: "**/*.ts" } },
      { name: "grep", args: { pattern: "TODO" } },
    ])

    expect(batches).toEqual([
      [
        { name: "read", args: { path: "alpha.ts" } },
        { name: "glob", args: { pattern: "**/*.ts" } },
        { name: "grep", args: { pattern: "TODO" } },
      ],
    ])
  })

  test("path-scoped tools with overlapping paths are separated", () => {
    const batches = canParallelize([
      { name: "write", args: { path: "src" } },
      { name: "edit", args: { path: "src/app.ts" } },
    ])

    expect(batches).toEqual([
      [{ name: "write", args: { path: "src" } }],
      [{ name: "edit", args: { path: "src/app.ts" } }],
    ])
  })

  test("path-scoped tools with disjoint paths are grouped", () => {
    const batches = canParallelize([
      { name: "write", args: { path: "src/app.ts" } },
      { name: "edit", args: { path: "docs/readme.md" } },
    ])

    expect(batches).toEqual([
      [
        { name: "write", args: { path: "src/app.ts" } },
        { name: "edit", args: { path: "docs/readme.md" } },
      ],
    ])
  })

  test("missing path-scoped path falls back to a solo batch", () => {
    const batches = canParallelize([
      { name: "write", args: { content: "hello" } },
      { name: "glob", args: { pattern: "**/*.ts" } },
    ])

    expect(batches).toEqual([
      [{ name: "write", args: { content: "hello" } }],
      [{ name: "glob", args: { pattern: "**/*.ts" } }],
    ])
  })

  test("unknown tools fall back to solo batches", () => {
    const batches = canParallelize([
      { name: "custom_tool", args: {} },
      { name: "read", args: { path: "alpha.ts" } },
    ])

    expect(batches).toEqual([
      [{ name: "custom_tool", args: {} }],
      [{ name: "read", args: { path: "alpha.ts" } }],
    ])
  })
})
