import { z } from "zod"

export const OrchestrationRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  trigger: z.enum(["cli"]),
  status: z.enum([
    "queued",
    "running",
    "waiting_permission",
    "completed",
    "failed",
    "cancelled",
  ]),
})

export const RunSchema = OrchestrationRunSchema

export type OrchestrationRun = z.infer<typeof OrchestrationRunSchema>
export type Run = OrchestrationRun
