import { describe, expect, test } from "bun:test"
import type { AgentProfile } from "../../src/agent/domain/agent-profile"
import { AgentProfileSchema } from "../../src/agent/domain/agent-profile-schema"

describe("AgentProfileSchema", () => {
  test("keeps backwards compatibility when new fields are omitted", () => {
    const result = AgentProfileSchema.parse({ name: "minimal" })

    expect(result.name).toBe("minimal")
    expect(result.temperature).toBeUndefined()
    expect(result.isPrimary).toBeUndefined()
    expect(result.skills).toEqual([])
  })

  test("accepts temperature values within the inclusive range", () => {
    for (const temperature of [0, 1, 2]) {
      const result = AgentProfileSchema.parse({ name: "temp-agent", temperature })
      expect(result.temperature).toBe(temperature)
    }
  })

  test("accepts isPrimary as a boolean", () => {
    expect(AgentProfileSchema.parse({ name: "primary", isPrimary: true }).isPrimary).toBe(true)
    expect(AgentProfileSchema.parse({ name: "secondary", isPrimary: false }).isPrimary).toBe(false)
  })

  test("supports the new AgentProfile fields in the interface", () => {
    const profile: AgentProfile = {
      name: "typed-agent",
      temperature: 1,
      isPrimary: true,
    }

    expect(profile.temperature).toBe(1)
    expect(profile.isPrimary).toBe(true)
  })

  test("rejects temperature below 0", () => {
    expect(() => AgentProfileSchema.parse({ name: "too-cold", temperature: -1 })).toThrow()
  })

  test("rejects temperature above 2", () => {
    expect(() => AgentProfileSchema.parse({ name: "too-hot", temperature: 3 })).toThrow()
  })

  test("rejects non-boolean isPrimary", () => {
    expect(() => AgentProfileSchema.parse({ name: "bad-primary", isPrimary: "yes" })).toThrow()
  })
})
