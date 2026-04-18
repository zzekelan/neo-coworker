import { describe, test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadAgentProfiles,
  loadMergedAgentProfiles,
} from "../../src/agent/infrastructure/agent-profile-loader"
import { createAgentProfileService } from "../../src/agent/public/index"

describe("loadAgentProfiles", () => {
  test("loads profiles from valid directory", async () => {
    await withWorkspace("agent-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "researcher.md", researcherAgentFrontmatter)

      const profiles = await loadAgentProfiles(workspaceRoot)

      expect(profiles).toHaveLength(1)
      expect(profiles[0].name).toBe("researcher")
      expect(profiles[0].parallel).toBe(true)
    })
  })

  test("returns empty array when directory missing", async () => {
    const profiles = await loadAgentProfiles("/nonexistent/path/xyz")
    expect(profiles).toEqual([])
  })

  test("skips files with invalid frontmatter without crashing", async () => {
    await withWorkspace("agent-bad-", async (workspaceRoot) => {
      // Missing required 'name' field
      await writeAgentFile(workspaceRoot, "invalid.md", [
        "---",
        "description: no name here",
        "---",
        "content",
      ])
      await writeAgentFile(workspaceRoot, "valid.md", ["---", "name: valid-agent", "---"])

      const profiles = await loadAgentProfiles(workspaceRoot)

      expect(profiles).toHaveLength(1)
      expect(profiles[0].name).toBe("valid-agent")
    })
  })

  test("parses tools array from frontmatter", async () => {
    await withWorkspace("agent-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "researcher.md", researcherAgentFrontmatter)

      const profiles = await loadAgentProfiles(workspaceRoot)

      expect(profiles[0].tools).toEqual(["read", "grep"])
    })
  })

  test("parses skills array from frontmatter", async () => {
    await withWorkspace("agent-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "researcher.md", researcherAgentFrontmatter)

      const profiles = await loadAgentProfiles(workspaceRoot)

      expect(profiles[0].skills).toEqual([])
    })
  })

  test("uses multiline markdown instructions when merging builtin, YAML, and markdown layers", async () => {
    await withWorkspace("agent-merge-", async (workspaceRoot) => {
      await writeFile(
        join(workspaceRoot, ".ncoworker", "agents.yaml"),
        ["agents:", "  default:", "    temperature: 0.2"].join("\n"),
      )
      await writeAgentFile(workspaceRoot, "default.md", [
        "---",
        "name: default",
        "instructions: |",
        "  Focus on review output.",
        "  Keep feedback concise.",
        "---",
        "# Default Agent",
      ])

      const profiles = await loadMergedAgentProfiles(workspaceRoot)
      const profile = profiles.find((candidate) => candidate.name === "default")

      expect(profile).toMatchObject({
        name: "default",
        temperature: 0.2,
        instructions: "Focus on review output.\nKeep feedback concise.",
      })
    })
  })
})

describe("createAgentProfileService", () => {
  test("getProfile finds profile by name", async () => {
    await withWorkspace("agent-svc-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "coder.md", coderAgentFrontmatter)

      const service = createAgentProfileService(workspaceRoot)
      const profile = await service.getProfile("coder")

      expect(profile?.name).toBe("coder")
      expect(profile?.parallel).toBe(false)
    })
  })

  test("getProfile returns undefined for unknown name", async () => {
    await withWorkspace("agent-svc-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "coder.md", coderAgentFrontmatter)

      const service = createAgentProfileService(workspaceRoot)
      const profile = await service.getProfile("unknown")

      expect(profile).toBeUndefined()
    })
  })

  test("listProfiles returns available names", async () => {
    await withWorkspace("agent-svc-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "coder.md", coderAgentFrontmatter)

      const service = createAgentProfileService(workspaceRoot)
      const names = await service.listProfiles()

      expect(names).toContain("coder")
    })
  })

  test("caches results: only loads once per service instance", async () => {
    await withWorkspace("agent-svc-test-", async (workspaceRoot) => {
      await writeAgentFile(workspaceRoot, "coder.md", coderAgentFrontmatter)

      const service = createAgentProfileService(workspaceRoot)
      const first = await service.loadProfiles()
      const second = await service.loadProfiles()

      expect(first).toBe(second)
    })
  })
})

const researcherAgentFrontmatter = [
  "---",
  "name: researcher",
  "tools:",
  "  - read",
  "  - grep",
  "parallel: true",
  "skills: []",
  "---",
  "# Researcher Agent",
  "This agent researches code.",
]

const coderAgentFrontmatter = [
  "---",
  "name: coder",
  "tools:",
  "  - read",
  "  - write",
  "parallel: false",
  "---",
]

async function withWorkspace(prefix: string, run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix))

  try {
    await mkdir(join(workspaceRoot, ".ncoworker", "agents"), { recursive: true })
    await run(workspaceRoot)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function writeAgentFile(workspaceRoot: string, fileName: string, lines: string[]) {
  await writeFile(join(workspaceRoot, ".ncoworker", "agents", fileName), lines.join("\n"))
}
