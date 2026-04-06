import { describe, it, expect } from "bun:test";
import { AgentProfileSchema } from "../../src/agent/domain/agent-profile-schema";
import type { AgentProfile } from "../../src/agent/domain/agent-profile";

describe("AgentProfile", () => {
  it("validates a full valid profile including parallel and skills", () => {
    const result = AgentProfileSchema.parse({
      name: "researcher",
      tools: ["read", "grep", "glob"],
      maxTurns: 10,
      parallel: true,
      skills: ["code-review"]
    });
    expect(result.name).toBe("researcher");
    expect(result.parallel).toBe(true);
    expect(result.skills).toEqual(["code-review"]);
  });

  it("rejects profile without name", () => {
    expect(() => AgentProfileSchema.parse({ tools: ["read"] })).toThrow();
  });

  it("defaults parallel to undefined", () => {
    const result = AgentProfileSchema.parse({ name: "minimal" });
    expect(result.parallel).toBeUndefined();
  });

  it("defaults skills to empty array", () => {
    const result = AgentProfileSchema.parse({ name: "minimal" });
    expect(result.skills).toEqual([]);
  });

  it("accepts tools wildcard ['*']", () => {
    const result = AgentProfileSchema.parse({ name: "admin", tools: ["*"] });
    expect(result.tools).toEqual(["*"]);
  });

  it("accepts a full profile with all optional fields", () => {
    const profile: AgentProfile = {
      name: "full-agent",
      description: "A complete agent profile",
      tools: ["read", "write"],
      disallowedTools: ["shell"],
      permissionMode: "restricted",
      model: "claude-3-opus",
      maxTurns: 20,
      systemPromptOverride: "You are a specialized agent.",
      instructions: "Focus on code quality.",
      parallel: false,
      skills: ["code-review", "security-audit"],
    };
    const result = AgentProfileSchema.parse(profile);
    expect(result.name).toBe("full-agent");
    expect(result.permissionMode).toBe("restricted");
    expect(result.disallowedTools).toEqual(["shell"]);
  });

  it("rejects invalid permissionMode", () => {
    expect(() =>
      AgentProfileSchema.parse({ name: "bad", permissionMode: "superuser" })
    ).toThrow();
  });

  it("rejects non-positive maxTurns", () => {
    expect(() =>
      AgentProfileSchema.parse({ name: "bad", maxTurns: 0 })
    ).toThrow();
  });

  it("accepts maxTurns as a positive integer", () => {
    const result = AgentProfileSchema.parse({ name: "agent", maxTurns: 5 });
    expect(result.maxTurns).toBe(5);
  });
});
