import { describe, expect, test } from "bun:test"
import { manageResultSize } from "../../../src/tool/application/result-size-manager"

describe("manageResultSize", () => {
  test("passes through small results unchanged", () => {
    const smallOutput = "a".repeat(1024)
    const result = { output: smallOutput }

    const managed = manageResultSize(result)

    expect(managed.output).toBe(smallOutput)
    expect(managed.metadata?.truncated).toBeUndefined()
  })

  test("truncates large results and sets metadata", () => {
    const largeOutput = "x".repeat(100_000)
    const result = { output: largeOutput }

    const managed = manageResultSize(result, 50_000)

    expect(managed.output.length).toBeLessThan(52_000)
    expect(managed.output).toContain("[Result truncated:")
    expect(managed.output).toContain("100000B")
    expect(managed.metadata?.truncated).toBe(true)
    expect(managed.metadata?.originalSize).toBe(100_000)
  })

  test("does not truncate isError results even when large", () => {
    const largeErrorOutput = "e".repeat(100_000)
    const result = { output: largeErrorOutput, isError: true as const }

    const managed = manageResultSize(result, 50_000)

    expect(managed.output).toBe(largeErrorOutput)
    expect(managed.metadata?.truncated).toBeUndefined()
  })
})
