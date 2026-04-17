import { describe, expect, test } from "bun:test"
import {
  createAgentProfileService,
  type CreateAgentProfileServiceInput,
} from "../../src/agent/application/agent-profile-service"
import type { AgentProfile } from "../../src/agent/domain"

describe("createAgentProfileService", () => {
  test("resolves builtin, YAML, and markdown layers with later shallow overrides winning", async () => {
    const service = createService({
      builtinAgents: {
        default: {
          name: "default",
          description: "Builtin default",
          temperature: 1,
          instructions: "Builtin instructions",
          skills: ["builtin-skill"],
          isPrimary: true,
        },
      },
      yamlProfiles: [
        {
          name: "default",
          temperature: 0.8,
          instructions: "YAML instructions",
          skills: ["yaml-skill"],
        },
      ],
      markdownProfiles: [
        {
          name: "default",
          temperature: 0.5,
          instructions: "Markdown instructions",
          skills: ["markdown-skill"],
          tools: ["read"],
        },
      ],
    })

    const profile = await service.getResolvedProfile("default")

    expect(profile).toMatchObject({
      name: "default",
      description: "Builtin default",
      temperature: 0.5,
      instructions: "Markdown instructions",
      skills: ["markdown-skill"],
      isPrimary: true,
    })
    expect(profile).not.toHaveProperty("tools")
  })

  test("lists only merged primary agents", async () => {
    const service = createService({
      builtinAgents: {
        default: { name: "default", isPrimary: true },
        plan: { name: "plan", isPrimary: true },
        explore: { name: "explore", tools: ["read"] },
      },
      yamlProfiles: [{ name: "reviewer", isPrimary: true, description: "Custom primary" }],
      markdownProfiles: [{ name: "reviewer", instructions: "Markdown override" }],
    })

    const profiles = await service.listPrimaryAgents()

    expect(profiles.map((profile) => profile.name).sort()).toEqual([
      "default",
      "plan",
      "reviewer",
    ])
    expect(profiles.find((profile) => profile.name === "reviewer")).toMatchObject({
      description: "Custom primary",
      instructions: "Markdown override",
      isPrimary: true,
    })
  })

  test("returns undefined for unknown agent names", async () => {
    const service = createService({
      builtinAgents: {
        default: { name: "default", isPrimary: true },
      },
      yamlProfiles: [],
      markdownProfiles: [],
    })

    await expect(service.getResolvedProfile("missing-agent")).resolves.toBeUndefined()
    await expect(service.getProfile("missing-agent")).resolves.toBeUndefined()
  })

  test("reload clears the cache and re-reads all layers", async () => {
    let yamlProfiles: Partial<AgentProfile>[] = []
    let markdownProfiles: Partial<AgentProfile>[] = []
    let yamlLoadCount = 0
    let markdownLoadCount = 0
    let reloadCount = 0

    const service = createAgentProfileService({
      builtinAgents: {
        default: { name: "default", temperature: 1, isPrimary: true },
      },
      loadYamlProfiles: async () => {
        yamlLoadCount += 1
        return yamlProfiles
      },
      loadMarkdownProfiles: async () => {
        markdownLoadCount += 1
        return markdownProfiles
      },
      reloadSources: () => {
        reloadCount += 1
      },
    })

    const first = await service.getResolvedProfile("default")
    const second = await service.getResolvedProfile("default")

    expect(first).toBe(second)
    expect(first).toMatchObject({ name: "default", temperature: 1, isPrimary: true })
    expect(yamlLoadCount).toBe(1)
    expect(markdownLoadCount).toBe(1)

    yamlProfiles = [{ name: "default", temperature: 0.8 }]
    markdownProfiles = [{ name: "default", temperature: 0.6 }]

    const stillCached = await service.getResolvedProfile("default")
    expect(stillCached).toBe(first)
    expect(stillCached?.temperature).toBe(1)

    service.reload()

    const reloaded = await service.getResolvedProfile("default")

    expect(reloadCount).toBe(1)
    expect(reloaded).toMatchObject({ name: "default", temperature: 0.6, isPrimary: true })
    expect(yamlLoadCount).toBe(2)
    expect(markdownLoadCount).toBe(2)
  })
})

function createService(input: {
  builtinAgents: Record<string, AgentProfile>
  yamlProfiles: Partial<AgentProfile>[]
  markdownProfiles: Partial<AgentProfile>[]
}) {
  const serviceInput: CreateAgentProfileServiceInput = {
    builtinAgents: input.builtinAgents,
    loadYamlProfiles: async () => input.yamlProfiles,
    loadMarkdownProfiles: async () => input.markdownProfiles,
  }

  return createAgentProfileService(serviceInput)
}
