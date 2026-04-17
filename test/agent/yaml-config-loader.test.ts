import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentProfileService } from "../../src/agent/public"
import {
  clearYamlAgentConfigCache,
  loadYamlAgentConfig,
} from "../../src/agent/infrastructure/yaml-config-loader"

describe("loadYamlAgentConfig", () => {
  let workspaceRoot = ""

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "agent-yaml-"))
  })

  afterEach(async () => {
    clearYamlAgentConfigCache(workspaceRoot)
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it("parses valid agents.yaml entries with key-based names", async () => {
    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  test-agent:",
        "    temperature: 0.5",
        "    isPrimary: true",
        "    description: YAML test agent",
        "    skills:",
        "      - review-work",
      ].join("\n"),
    )

    const profiles = await loadYamlAgentConfig(workspaceRoot)

    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      name: "test-agent",
      temperature: 0.5,
      isPrimary: true,
      description: "YAML test agent",
      skills: ["review-work"],
    })
  })

  it("returns an empty array when agents.yaml is missing", async () => {
    const profiles = await loadYamlAgentConfig(workspaceRoot)

    expect(profiles).toEqual([])
  })

  it("warns and returns an empty array for invalid YAML", async () => {
    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  broken-agent:",
        "    temperature: [",
      ].join("\n"),
    )

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))

    try {
      const profiles = await loadYamlAgentConfig(workspaceRoot)

      expect(profiles).toEqual([])
      expect(warnings.some((warning) => warning.includes("Invalid YAML"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it("skips invalid entries and keeps valid ones", async () => {
    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  valid-agent:",
        "    temperature: 0.7",
        "  invalid-agent:",
        '    temperature: "not-a-number"',
      ].join("\n"),
    )

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))

    try {
      const profiles = await loadYamlAgentConfig(workspaceRoot)

      expect(profiles).toHaveLength(1)
      expect(profiles[0]).toMatchObject({
        name: "valid-agent",
        temperature: 0.7,
      })
      expect(warnings.some((warning) => warning.includes("invalid-agent"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it("ignores YAML tools for primary agents", async () => {
    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  default:",
        "    tools:",
        "      - read",
      ].join("\n"),
    )

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))

    try {
      const profiles = await loadYamlAgentConfig(workspaceRoot)

      expect(profiles).toHaveLength(1)
      expect(profiles[0]).toMatchObject({ name: "default" })
      expect(profiles[0]).not.toHaveProperty("tools")
      expect(warnings.some((warning) => warning.includes("Ignoring tools"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it("caches the first parsed result for a workspace", async () => {
    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  cached-agent:",
        "    temperature: 0.5",
      ].join("\n"),
    )

    const first = await loadYamlAgentConfig(workspaceRoot)

    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  cached-agent:",
        "    temperature: 0.9",
      ].join("\n"),
    )

    const second = await loadYamlAgentConfig(workspaceRoot)

    expect(second).toBe(first)
    expect(second[0]).toMatchObject({
      name: "cached-agent",
      temperature: 0.5,
    })
  })
})

describe("createAgentProfileService YAML merge wiring", () => {
  let workspaceRoot = ""

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "agent-yaml-merge-"))
  })

  afterEach(async () => {
    clearYamlAgentConfigCache(workspaceRoot)
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  it("merges builtin, YAML, and markdown profiles in override order", async () => {
    await writeAgentsYaml(
      workspaceRoot,
      [
        "agents:",
        "  default:",
        "    temperature: 0.8",
        '    instructions: "From YAML"',
      ].join("\n"),
    )

    await mkdir(join(workspaceRoot, ".ncoworker", "agents"), { recursive: true })
    await writeFile(
      join(workspaceRoot, ".ncoworker", "agents", "default.md"),
      [
        "---",
        "name: default",
        "temperature: 0.5",
        "instructions: From markdown",
        "---",
        "# Default override",
      ].join("\n"),
    )

    const service = createAgentProfileService(workspaceRoot)
    const profile = await service.getProfile("default")

    expect(profile).toBeDefined()
    expect(profile).toMatchObject({
      name: "default",
      description: "General-purpose assistant",
      temperature: 0.5,
      instructions: "From markdown",
      isPrimary: true,
    })
  })
})

async function writeAgentsYaml(workspaceRoot: string, content: string) {
  await mkdir(join(workspaceRoot, ".ncoworker"), { recursive: true })
  await writeFile(join(workspaceRoot, ".ncoworker", "agents.yaml"), `${content}\n`)
}
