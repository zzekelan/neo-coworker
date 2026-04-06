import { z } from "zod"

export const AgentProfileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tools: z.union([z.array(z.string()), z.tuple([z.literal("*")])]).optional(),
  disallowedTools: z.array(z.string()).optional(),
  permissionMode: z.enum(["default", "restricted", "permissive"]).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  systemPromptOverride: z.string().optional(),
  instructions: z.string().optional(),
  parallel: z.boolean().optional(),
  skills: z.array(z.string()).default([]),
})

export type AgentProfileInput = z.input<typeof AgentProfileSchema>
export type AgentProfileOutput = z.output<typeof AgentProfileSchema>
