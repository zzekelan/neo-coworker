import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { loadAgentProfiles } from "../../src/agent/infrastructure/agent-profile-loader"
import { createAgentProfileService } from "../../src/agent/public/index"

describe("loadAgentProfiles", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-test-"))
    await mkdir(join(tmpDir, ".ncoworker", "agents"), { recursive: true })
    await writeFile(
      join(tmpDir, ".ncoworker", "agents", "researcher.md"),
      [
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
      ].join("\n"),
    )
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("loads profiles from valid directory", async () => {
    const profiles = await loadAgentProfiles(tmpDir)
    expect(profiles).toHaveLength(1)
    expect(profiles[0].name).toBe("researcher")
    expect(profiles[0].parallel).toBe(true)
  })

  it("returns empty array when directory missing", async () => {
    const profiles = await loadAgentProfiles("/nonexistent/path/xyz")
    expect(profiles).toEqual([])
  })

  it("skips files with invalid frontmatter without crashing", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "agent-bad-"))
    try {
      await mkdir(join(badDir, ".ncoworker", "agents"), { recursive: true })
      // Missing required 'name' field
      await writeFile(
        join(badDir, ".ncoworker", "agents", "invalid.md"),
        ["---", "description: no name here", "---", "content"].join("\n"),
      )
      await writeFile(
        join(badDir, ".ncoworker", "agents", "valid.md"),
        ["---", "name: valid-agent", "---"].join("\n"),
      )
      const profiles = await loadAgentProfiles(badDir)
      expect(profiles).toHaveLength(1)
      expect(profiles[0].name).toBe("valid-agent")
    } finally {
      await rm(badDir, { recursive: true, force: true })
    }
  })

  it("parses tools array from frontmatter", async () => {
    const profiles = await loadAgentProfiles(tmpDir)
    expect(profiles[0].tools).toEqual(["read", "grep"])
  })

  it("parses skills array from frontmatter", async () => {
    const profiles = await loadAgentProfiles(tmpDir)
    expect(profiles[0].skills).toEqual([])
  })
})

describe("createAgentProfileService", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-svc-test-"))
    await mkdir(join(tmpDir, ".ncoworker", "agents"), { recursive: true })
    await writeFile(
      join(tmpDir, ".ncoworker", "agents", "coder.md"),
      [
        "---",
        "name: coder",
        "tools:",
        "  - read",
        "  - write",
        "parallel: false",
        "---",
      ].join("\n"),
    )
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("getProfile finds profile by name", async () => {
    const service = createAgentProfileService(tmpDir)
    const profile = await service.getProfile("coder")
    expect(profile?.name).toBe("coder")
    expect(profile?.parallel).toBe(false)
  })

  it("getProfile returns undefined for unknown name", async () => {
    const service = createAgentProfileService(tmpDir)
    const profile = await service.getProfile("unknown")
    expect(profile).toBeUndefined()
  })

  it("listProfiles returns available names", async () => {
    const service = createAgentProfileService(tmpDir)
    const names = await service.listProfiles()
    expect(names).toContain("coder")
  })

  it("caches results: only loads once per service instance", async () => {
    const service = createAgentProfileService(tmpDir)
    const first = await service.loadProfiles()
    const second = await service.loadProfiles()
    expect(first).toBe(second)
  })
})
