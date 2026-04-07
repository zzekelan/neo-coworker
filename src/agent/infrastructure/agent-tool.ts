import { z } from "zod"
import type { AgentProfileService } from "../application/agent-profile-service"
import { BUILTIN_AGENTS, getBuiltinAgent } from "../domain/builtin-agents"
import type { AgentProfile } from "../domain/agent-profile"

type AgentToolExecutionInput = {
  args: unknown
  signal?: AbortSignal
}

type AgentToolExecutionResult = {
  output: string
  isError?: boolean
}

const MAX_SUB_AGENT_DEPTH = 1

const WRITE_TOOLS = new Set(["write", "edit", "shell"])

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "lsp_symbols",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_diagnostics",
  "webfetch",
  "websearch",
  "codesearch",
  "get_current_datetime",
])

const AgentToolArgsSchema = z.object({
  agent: z.string().trim().min(1).describe("Agent profile name to run for this delegated task."),
  prompt: z.string().trim().min(1).describe("Task description for the delegated sub-agent run."),
})

const AgentConcurrencyInputSchema = z.object({
  agent: z.string().trim().min(1),
})

function normalizeError(output: string): AgentToolExecutionResult {
  return {
    output,
    isError: true,
  }
}

async function resolveAgentProfile(
  service: AgentProfileService,
  name: string,
): Promise<AgentProfile | undefined> {
  return getBuiltinAgent(name) ?? (await service.getProfile(name))
}

async function listAvailableAgents(service: AgentProfileService): Promise<string[]> {
  const builtins = Object.keys(BUILTIN_AGENTS)
  const custom = await service.listProfiles()
  return [...new Set([...builtins, ...custom])].sort((left, right) => left.localeCompare(right))
}

function getServiceProfileForConcurrency(
  service: AgentProfileService,
  name: string,
): AgentProfile | undefined {
  const result = (service as {
    getProfile(name: string): AgentProfile | Promise<AgentProfile | undefined> | undefined
  }).getProfile(name)

  if (!result || typeof result !== "object" || !("then" in result)) {
    return result
  }

  return undefined
}

function inferParallelSafety(profile: AgentProfile | undefined): boolean {
  if (!profile) {
    return false
  }

  if (profile.parallel !== undefined) {
    return profile.parallel
  }

  if (!profile.tools || profile.tools.length === 0) {
    return false
  }

  if (profile.tools.length === 1 && profile.tools[0] === "*") {
    return false
  }

  if (profile.tools.some((tool) => WRITE_TOOLS.has(tool))) {
    return false
  }

  return profile.tools.every((tool) => READ_ONLY_TOOLS.has(tool))
}

export function createAgentTool(config: {
  sessionId: string
  runId: string
  agentProfileService: AgentProfileService
  createSubAgentRun: (profile: AgentProfile, prompt: string, signal?: AbortSignal) => Promise<string>
  currentDepth: number
}) {
  return {
    name: "agent",
    description:
      "Delegate focused work to a named sub-agent when you need isolated codebase exploration, parallel research, or a constrained specialist workflow with a specific tool budget.",
    inputSchema: AgentToolArgsSchema,
    concurrency: "read-only" as const,
    isConcurrencySafe(input: unknown) {
      const parsed = AgentConcurrencyInputSchema.safeParse(input)
      if (!parsed.success) {
        return false
      }

      return inferParallelSafety(
        getBuiltinAgent(parsed.data.agent) ??
          getServiceProfileForConcurrency(config.agentProfileService, parsed.data.agent),
      )
    },
    async execute(input: AgentToolExecutionInput): Promise<AgentToolExecutionResult> {
      const parsed = AgentToolArgsSchema.safeParse(input.args)
      if (!parsed.success) {
        return normalizeError(parsed.error.issues.map((issue) => issue.message).join("; "))
      }

      const profile = await resolveAgentProfile(config.agentProfileService, parsed.data.agent)
      if (!profile) {
        const availableAgents = await listAvailableAgents(config.agentProfileService)
        return normalizeError(
          `Unknown agent '${parsed.data.agent}'. Available agents: ${availableAgents.join(", ") || "none"}.`,
        )
      }

      if (config.currentDepth >= MAX_SUB_AGENT_DEPTH) {
        return normalizeError(
          `Sub-agent depth limit reached. Current depth ${config.currentDepth}, maximum ${MAX_SUB_AGENT_DEPTH}.`,
        )
      }

      const output = await config.createSubAgentRun(profile, parsed.data.prompt, input.signal)
      return { output }
    },
    usageGuidance:
      "Use when the task benefits from a named specialist agent, especially for isolated exploration or parallelizable subproblems. Do not use for trivial single-step work.",
    isCompressible: true,
  }
}
