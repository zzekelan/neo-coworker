import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  assertWorkspacePathNotReserved,
  isWorkspacePathReserved,
} from "../../src/tool/domain"
import { listWorkspaceFiles } from "../../src/tool/infrastructure/builtins/workspace-files"

describe(".ncoworker path safety", () => {
  test("allows only explicit workspace subtrees under root .ncoworker", () => {
    const allowedPaths = [
      ".ncoworker/research/topic/brief.md",
      ".ncoworker/skills/reviewer/SKILL.md",
      ".ncoworker/tool-results/read/result.txt",
      ".ncoworker/memory/agent.md",
      ".ncoworker/permissions/allowlist.json",
      ".ncoworker/evals/run/trace.json",
    ]

    for (const path of allowedPaths) {
      expect(isWorkspacePathReserved(path)).toBe(false)
      expect(() => assertWorkspacePathNotReserved(path)).not.toThrow()
    }
  })

  test("keeps unrelated and nested .ncoworker runtime paths reserved", () => {
    const blockedPaths = [
      ".ncoworker",
      ".ncoworker/secret.txt",
      ".ncoworker/agent.sqlite",
      ".ncoworker/research/../secret.txt",
      "nested/.ncoworker/research/topic/brief.md",
      ".agents/research/topic/brief.md",
    ]

    for (const path of blockedPaths) {
      expect(isWorkspacePathReserved(path)).toBe(true)
      expect(() => assertWorkspacePathNotReserved(path)).toThrow("Path is reserved for agent runtime data")
    }
  })

  test("workspace discovery lists allowed research artifacts without exposing runtime files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "tool-ncoworker-path-safety-"))

    await mkdir(join(workspaceRoot, ".ncoworker", "research", "topic"), { recursive: true })
    await writeFile(join(workspaceRoot, ".ncoworker", "research", "topic", "brief.md"), "# Brief\n")
    await writeFile(join(workspaceRoot, ".ncoworker", "secret.txt"), "secret\n")

    const files = await listWorkspaceFiles({ workspaceRoot })

    expect(files).toContain(".ncoworker/research/topic/brief.md")
    expect(files).not.toContain(".ncoworker/secret.txt")
  })
})
