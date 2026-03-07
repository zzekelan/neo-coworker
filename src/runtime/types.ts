import { z } from "zod"

export const RunSchema = z.object({
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

export type Run = z.infer<typeof RunSchema>
