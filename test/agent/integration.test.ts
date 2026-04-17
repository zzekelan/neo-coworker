import { describe, expect, test } from "bun:test"
import {
  AgentProfileSchema,
  BUILTIN_AGENTS,
  createAgentTool,
  createSubAgentContext,
  filterToolsForAgent,
  getBuiltinAgent,
  type AgentProfile,
  type AgentProfileService,
} from "../../src/agent"

function makeTool(name: string) {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: undefined as never,
    async execute() {
      return { output: "" }
    },
  }
}

function makeInMemoryProfileService(profiles: AgentProfile[]): AgentProfileService {
  return {
    async loadProfiles() {
      return profiles
    },
    async getProfile(name: string) {
      return profiles.find((p) => p.name === name)
    },
    async listProfiles() {
      return profiles.map((p) => p.name)
    },
    async getResolvedProfile(name: string) {
      return profiles.find((p) => p.name === name)
    },
    async listPrimaryAgents() {
      return profiles.filter((profile) => profile.isPrimary === true)
    },
    reload() {},
  }
}

describe("builtin agents", () => {
  test("exposes the explore agent via getBuiltinAgent", () => {
    const explore = getBuiltinAgent("explore")

    expect(explore).not.toBeUndefined()
    expect(explore!.name).toBe("explore")
    expect(explore!.tools).toContain("read")
    expect(explore!.tools).toContain("grep")
    expect(explore!.tools).toContain("glob")
  })

  test("explore agent does NOT include write, edit, or shell", () => {
    const explore = getBuiltinAgent("explore")!

    expect(explore.tools).not.toContain("write")
    expect(explore.tools).not.toContain("edit")
    expect(explore.tools).not.toContain("shell")
  })

  test("explore agent is parallel-safe (read-only)", () => {
    const explore = getBuiltinAgent("explore")!

    expect(explore.parallel).toBe(true)
  })

  test("BUILTIN_AGENTS map contains explore", () => {
    expect(Object.keys(BUILTIN_AGENTS)).toContain("explore")
  })

  test("returns undefined for an unknown agent name", () => {
    expect(getBuiltinAgent("does-not-exist")).toBeUndefined()
  })
})

describe("createAgentTool", () => {
  const profileService = makeInMemoryProfileService([])
  const agentTool = createAgentTool({
    sessionId: "session-1",
    runId: "run-1",
    agentProfileService: profileService,
    currentDepth: 0,
    async createSubAgentRun() {
      return "mock-output"
    },
  })

  test("has name 'agent'", () => {
    expect(agentTool.name).toBe("agent")
  })

  test("has a non-empty description", () => {
    expect(typeof agentTool.description).toBe("string")
    expect(agentTool.description.length).toBeGreaterThan(0)
  })

  test("has an inputSchema defined", () => {
    expect(agentTool.inputSchema).toBeDefined()
  })

  test("has an execute function", () => {
    expect(typeof agentTool.execute).toBe("function")
  })

  test("isConcurrencySafe returns true for the explore agent (parallel=true)", () => {
    expect(agentTool.isConcurrencySafe({ agent: "explore", prompt: "check" })).toBe(true)
  })

  test("isConcurrencySafe returns false for an unknown agent", () => {
    expect(agentTool.isConcurrencySafe({ agent: "unknown-agent", prompt: "x" })).toBe(false)
  })

  test("returns an error result when depth limit is reached", async () => {
    const deepTool = createAgentTool({
      sessionId: "session-2",
      runId: "run-2",
      agentProfileService: makeInMemoryProfileService([]),
      currentDepth: 1,
      async createSubAgentRun() {
        return "should-not-reach"
      },
    })

    const result = await deepTool.execute({
      args: { agent: "explore", prompt: "do something" },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("depth limit")
  })

  test("returns an error result for unknown agent name", async () => {
    const result = await agentTool.execute({
      args: { agent: "totally-unknown", prompt: "do something" },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("Unknown agent")
  })

  test("delegates to createSubAgentRun for a valid known agent", async () => {
    let capturedProfile: AgentProfile | undefined
    const trackingTool = createAgentTool({
      sessionId: "session-3",
      runId: "run-3",
      agentProfileService: makeInMemoryProfileService([]),
      currentDepth: 0,
      async createSubAgentRun(profile) {
        capturedProfile = profile
        return "tracked-output"
      },
    })

    const result = await trackingTool.execute({
      args: { agent: "explore", prompt: "analyze" },
    })

    expect(result.isError).toBeUndefined()
    expect(result.output).toBe("tracked-output")
    expect(capturedProfile?.name).toBe("explore")
  })
})

describe("filterToolsForAgent — sub-agent tool isolation", () => {
  const parentTools = ["read", "write", "edit", "grep", "glob", "shell", "agent", "skill"].map(
    makeTool,
  )

  test("only exposes whitelisted tools to a sub-agent", () => {
    const profile: AgentProfile = {
      name: "researcher",
      tools: ["read", "grep", "glob"],
    }

    const filtered = filterToolsForAgent(parentTools, profile)
    const names = filtered.map((t) => t.name)

    expect(names).toContain("read")
    expect(names).toContain("grep")
    expect(names).toContain("glob")
    expect(names).not.toContain("write")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("shell")
  })

  test("always excludes agent and skill tools regardless of profile whitelist", () => {
    const profile: AgentProfile = {
      name: "full-access",
      tools: ["read", "agent", "skill"],
    }

    const filtered = filterToolsForAgent(parentTools, profile)
    const names = filtered.map((t) => t.name)

    expect(names).not.toContain("agent")
    expect(names).not.toContain("skill")
    expect(names).toContain("read")
  })

  test("applies disallowedTools on top of whitelist", () => {
    const profile: AgentProfile = {
      name: "restricted",
      tools: ["*"],
      disallowedTools: ["shell"],
    }

    const filtered = filterToolsForAgent(parentTools, profile)
    const names = filtered.map((t) => t.name)

    expect(names).not.toContain("shell")
    expect(names).not.toContain("agent")
    expect(names).not.toContain("skill")
    expect(names).toContain("read")
    expect(names).toContain("grep")
    expect(names).toContain("write")
  })
})

describe("createSubAgentContext — isolation", () => {
  test("generates a unique subRunId per call while preserving sessionId", () => {
    const ctx1 = createSubAgentContext({ sessionId: "my-session" })
    const ctx2 = createSubAgentContext({ sessionId: "my-session" })

    expect(ctx1.sessionId).toBe("my-session")
    expect(ctx2.sessionId).toBe("my-session")
    expect(ctx1.subRunId).toMatch(/^run_/)
    expect(ctx2.subRunId).toMatch(/^run_/)
    expect(ctx1.subRunId).not.toBe(ctx2.subRunId)
  })

  test("provides its own abort signal isolated from parent", () => {
    const parent = new AbortController()
    const ctx = createSubAgentContext({ sessionId: "s", signal: parent.signal })

    expect(ctx.signal).toBeDefined()
    expect(ctx.signal.aborted).toBe(false)

    parent.abort("parent-stopped")

    expect(ctx.signal.aborted).toBe(true)
    expect(ctx.signal.reason).toBe("parent-stopped")
  })
})

describe("AgentProfileSchema", () => {
  test("parses a valid minimal profile (name only)", () => {
    const result = AgentProfileSchema.safeParse({ name: "my-agent" })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("my-agent")
      expect(result.data.skills).toEqual([])
    }
  })

  test("parses a full profile with all optional fields", () => {
    const result = AgentProfileSchema.safeParse({
      name: "researcher",
      description: "A research agent",
      tools: ["read", "grep", "glob"],
      disallowedTools: ["write"],
      permissionMode: "restricted",
      model: "gpt-4",
      maxTurns: 5,
      systemPromptOverride: "You are a researcher.",
      instructions: "Focus on facts.",
      parallel: false,
      skills: ["code-review"],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("researcher")
      expect(result.data.tools).toEqual(["read", "grep", "glob"])
      expect(result.data.disallowedTools).toEqual(["write"])
      expect(result.data.permissionMode).toBe("restricted")
      expect(result.data.maxTurns).toBe(5)
      expect(result.data.parallel).toBe(false)
      expect(result.data.skills).toEqual(["code-review"])
    }
  })

  test("accepts the wildcard tools value ['*']", () => {
    const result = AgentProfileSchema.safeParse({ name: "admin", tools: ["*"] })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools).toEqual(["*"])
    }
  })

  test("rejects an invalid permissionMode", () => {
    const result = AgentProfileSchema.safeParse({ name: "bad", permissionMode: "superuser" })

    expect(result.success).toBe(false)
  })

  test("rejects a non-positive maxTurns", () => {
    const result = AgentProfileSchema.safeParse({ name: "bad", maxTurns: 0 })

    expect(result.success).toBe(false)
  })

  test("rejects a profile with no name", () => {
    const result = AgentProfileSchema.safeParse({ tools: ["read"] })

    expect(result.success).toBe(false)
  })
})

describe("createAgentProfileService (in-memory adapter)", () => {
  const profiles: AgentProfile[] = [
    { name: "alpha", tools: ["read"], skills: [] },
    { name: "beta", tools: ["grep"], parallel: true, skills: [] },
  ]
  const service = makeInMemoryProfileService(profiles)

  test("loadProfiles returns all profiles", async () => {
    const loaded = await service.loadProfiles()

    expect(loaded).toHaveLength(2)
    expect(loaded.map((p) => p.name)).toContain("alpha")
    expect(loaded.map((p) => p.name)).toContain("beta")
  })

  test("getProfile returns the matching profile by name", async () => {
    const profile = await service.getProfile("beta")

    expect(profile).toBeDefined()
    expect(profile!.tools).toContain("grep")
    expect(profile!.parallel).toBe(true)
  })

  test("getProfile returns undefined for missing name", async () => {
    const profile = await service.getProfile("gamma")

    expect(profile).toBeUndefined()
  })

  test("listProfiles returns all profile names", async () => {
    const names = await service.listProfiles()

    expect(names).toContain("alpha")
    expect(names).toContain("beta")
  })

  test("createAgentTool lists available agents combining builtins and custom profiles", async () => {
    const customService = makeInMemoryProfileService([{ name: "custom-agent", skills: [] }])
    const tool = createAgentTool({
      sessionId: "s",
      runId: "r",
      agentProfileService: customService,
      currentDepth: 0,
      async createSubAgentRun() {
        return ""
      },
    })

    const result = await tool.execute({
      args: { agent: "nonexistent", prompt: "x" },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("custom-agent")
    expect(result.output).toContain("explore")
  })
})
