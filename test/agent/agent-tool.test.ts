import { describe, expect, test } from "bun:test"
import type { AgentProfile } from "../../src/agent"
import {
  BUILTIN_AGENTS,
  createAgentTool,
  type AgentProfileService,
} from "../../src/agent"

function createAgentProfileServiceStub(profiles: AgentProfile[] = []): AgentProfileService {
  return {
    async loadProfiles() {
      return profiles
    },
    getProfile(name: string) {
      return profiles.find((profile) => profile.name === name) as AgentProfile | undefined
    },
    async listProfiles() {
      return profiles.map((profile) => profile.name)
    },
  } as unknown as AgentProfileService
}

describe("createAgentTool", () => {
  test("Agent Tool 正确创建 ToolDefinition", () => {
    const tool = createAgentTool({
      sessionId: "session-1",
      runId: "run-1",
      agentProfileService: createAgentProfileServiceStub(),
      createSubAgentRun: async () => "ok",
      currentDepth: 0,
    })

    expect(tool.name).toBe("agent")
    expect(tool.execute).toBeFunction()
    expect(tool.isConcurrencySafe).toBeFunction()
  })

  test("profile 不存在时返回错误", async () => {
    const tool = createAgentTool({
      sessionId: "session-1",
      runId: "run-1",
      agentProfileService: createAgentProfileServiceStub([{ name: "helper" }]),
      createSubAgentRun: async () => "ok",
      currentDepth: 0,
    })

    const result = await tool.execute({
      toolName: "agent",
      args: {
        agent: "unknown",
        prompt: "Investigate the codebase",
      },
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toContain("unknown")
    expect(result.output).toContain("explore")
    expect(result.output).toContain("helper")
    expect(result.isError).toBe(true)
  })

  test("嵌套深度超限时拒绝", async () => {
    const tool = createAgentTool({
      sessionId: "session-1",
      runId: "run-1",
      agentProfileService: createAgentProfileServiceStub(),
      createSubAgentRun: async () => "ok",
      currentDepth: 1,
    })

    const result = await tool.execute({
      toolName: "agent",
      args: {
        agent: "explore",
        prompt: "Investigate the codebase",
      },
      workspaceRoot: process.cwd(),
    })

    expect(result.output).toMatch(/depth|maximum/i)
    expect(result.isError).toBe(true)
  })

  test("isConcurrencySafe — parallel=true 的 agent", () => {
    const tool = createAgentTool({
      sessionId: "session-1",
      runId: "run-1",
      agentProfileService: createAgentProfileServiceStub(),
      createSubAgentRun: async () => "ok",
      currentDepth: 0,
    })

    expect(tool.isConcurrencySafe?.({ agent: "explore" })).toBe(true)
    expect(BUILTIN_AGENTS.explore.parallel).toBe(true)
  })

  test("isConcurrencySafe — 未设置 parallel 的 write agent 推断为 false", () => {
    const tool = createAgentTool({
      sessionId: "session-1",
      runId: "run-1",
      agentProfileService: createAgentProfileServiceStub([
        {
          name: "writer",
          tools: ["write"],
        },
      ]),
      createSubAgentRun: async () => "ok",
      currentDepth: 0,
    })

    expect(tool.isConcurrencySafe?.({ agent: "writer" })).toBe(false)
  })

  test("isConcurrencySafe — read-only tools 推断为 true", () => {
    const tool = createAgentTool({
      sessionId: "session-1",
      runId: "run-1",
      agentProfileService: createAgentProfileServiceStub([
        {
          name: "reader",
          tools: ["read", "grep", "glob"],
        },
      ]),
      createSubAgentRun: async () => "ok",
      currentDepth: 0,
    })

    expect(tool.isConcurrencySafe?.({ agent: "reader" })).toBe(true)
  })
})
