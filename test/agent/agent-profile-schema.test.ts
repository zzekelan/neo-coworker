import { describe, expect, it } from "bun:test"
import type { AgentProfile } from "../../src/agent/domain/agent-profile"
import { AgentProfileSchema } from "../../src/agent/domain/agent-profile-schema"

describe("AgentProfileSchema", () => {
  it("keeps backwards compatibility when new fields are omitted", () => {
    const result = AgentProfileSchema.parse({ name: "minimal" })

    expect(result.name).toBe("minimal")
    expect(result.temperature).toBeUndefined()
    expect(result.isPrimary).toBeUndefined()
    expect(result.skills).toEqual([])
  })

  it("accepts temperature values within the inclusive range", () => {
    for (const temperature of [0, 1, 2]) {
      const result = AgentProfileSchema.parse({ name: "temp-agent", temperature })
      expect(result.temperature).toBe(temperature)
    }
  })

  it("accepts isPrimary as a boolean", () => {
    expect(AgentProfileSchema.parse({ name: "primary", isPrimary: true }).isPrimary).toBe(true)
    expect(AgentProfileSchema.parse({ name: "secondary", isPrimary: false }).isPrimary).toBe(false)
  })

  it("supports the new AgentProfile fields in the interface", () => {
    const profile: AgentProfile = {
      name: "typed-agent",
      temperature: 1,
      isPrimary: true,
    }

    expect(profile.temperature).toBe(1)
    expect(profile.isPrimary).toBe(true)
  })

  it("rejects temperature below 0", () => {
    expect(() => AgentProfileSchema.parse({ name: "too-cold", temperature: -1 })).toThrow()
  })

  it("rejects temperature above 2", () => {
    expect(() => AgentProfileSchema.parse({ name: "too-hot", temperature: 3 })).toThrow()
  })

  it("rejects non-boolean isPrimary", () => {
    expect(() => AgentProfileSchema.parse({ name: "bad-primary", isPrimary: "yes" })).toThrow()
  })
})
