import { describe, expect, test } from "bun:test"
import {
  createGlobTool,
  createGrepTool,
  createReadTool,
  createToolProvider,
  createToolRegistryService,
  createToolRuntimeApi,
  type ToolDefinition,
} from "../../src/tool"
import type { OrchestrationTool } from "../../src/orchestration"
import { getStaticPrompt } from "../../src/orchestration/application/system-prompt"
import type { ToolGuidanceEntry } from "../../src/orchestration/application/prompt-composer"

type GuidedOrchestrationTool = OrchestrationTool & {
  usageGuidance?: string
  isCompressible?: boolean
}

function deriveToolGuidanceEntries(tools: readonly GuidedOrchestrationTool[]): ToolGuidanceEntry[] {
  return tools
    .filter(
      (tool): tool is GuidedOrchestrationTool & { usageGuidance: string } =>
        Boolean(tool.usageGuidance?.trim()),
    )
    .map((tool) => ({
      name: tool.name,
      guidance: tool.usageGuidance,
      isReadOnly: tool.concurrency === "read-only",
    }))
}

describe("integration: tool guidance in system prompt", () => {
  test("propagates tool metadata through registry and orchestration listings into the composed prompt", () => {
    const customMutatingTool: ToolDefinition = {
      name: "custom_mutating",
      description: "Custom mutating tool with guidance",
      concurrency: "mutating",
      isCompressible: false,
      usageGuidance: "Use only after read-only inspection is complete.",
      async execute() {
        return { output: "ok" }
      },
    }
    const tools = [customMutatingTool, createReadTool(), createGlobTool(), createGrepTool()]
    const registryTools = createToolRegistryService(tools).listTools()
    const orchestrationTools = createToolProvider({
      runtime: createToolRuntimeApi({ tools }),
    }).list() as GuidedOrchestrationTool[]
    const toolGuidances = deriveToolGuidanceEntries(orchestrationTools)

    const prompt = getStaticPrompt(toolGuidances)

    expect(registryTools.find((tool) => tool.name === "read")).toMatchObject({
      usageGuidance: expect.stringContaining("offset"),
      isCompressible: true,
    })
    expect(registryTools.find((tool) => tool.name === "custom_mutating")).toMatchObject({
      usageGuidance: "Use only after read-only inspection is complete.",
      isCompressible: false,
    })
    expect(orchestrationTools.find((tool) => tool.name === "custom_mutating")).toMatchObject({
      usageGuidance: "Use only after read-only inspection is complete.",
      isCompressible: false,
    })
    expect(toolGuidances.map((entry) => entry.name)).toEqual([
      "custom_mutating",
      "read",
      "glob",
      "grep",
    ])
    expect(prompt).toContain("### Tool: read")
    expect(prompt).toContain("Use `offset` and `limit` to navigate large files.")
    expect(prompt).toContain("### Tool: glob")
    expect(prompt).toContain("Use glob when you need to discover files by name pattern or extension.")
    expect(prompt).toContain("### Tool: grep")
    expect(prompt).toContain("Prefer output_mode='files_with_matches' for broad discovery")
    expect(prompt).toContain("### Tool: custom_mutating")
    expect(prompt).toContain("Use only after read-only inspection is complete.")

    const readIndex = prompt.indexOf("### Tool: read")
    const globIndex = prompt.indexOf("### Tool: glob")
    const grepIndex = prompt.indexOf("### Tool: grep")
    const mutatingIndex = prompt.indexOf("### Tool: custom_mutating")

    expect(readIndex).toBeGreaterThan(-1)
    expect(globIndex).toBeGreaterThan(-1)
    expect(grepIndex).toBeGreaterThan(-1)
    expect(mutatingIndex).toBeGreaterThan(-1)
    expect(readIndex).toBeLessThan(mutatingIndex)
    expect(globIndex).toBeLessThan(mutatingIndex)
    expect(grepIndex).toBeLessThan(mutatingIndex)
  })

  test("omits tools that have no usageGuidance while preserving guided tools", () => {
    const customTool: ToolDefinition = {
      name: "custom_read_only",
      description: "Custom tool without prompt guidance",
      concurrency: "read-only",
      async execute() {
        return { output: "ok" }
      },
    }

    const prompt = getStaticPrompt(
      deriveToolGuidanceEntries(
        createToolProvider({
          runtime: createToolRuntimeApi({
            tools: [customTool, createReadTool()],
          }),
        }).list(),
      ),
    )

    expect(prompt).toContain("### Tool: read")
    expect(prompt).not.toContain("### Tool: custom_read_only")
  })
})
