import { z } from "zod"

export const EvalRunTraceEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  source: z.enum(["model", "orchestration", "permission", "tool"]),
  eventType: z.string(),
  createdAt: z.number().int(),
  data: z.record(z.string(), z.unknown()),
})

export const EvalRuntimeEventSchema = z.object({
  type: z.string(),
})

export const EvalRunArtifactSchema = z.object({
  taskId: z.string(),
  workspaceRoot: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  runStatus: z.enum([
    "queued",
    "running",
    "waiting_permission",
    "completed",
    "failed",
    "cancelled",
  ]),
  runtimeEvents: z.array(EvalRuntimeEventSchema),
  transcript: z.array(z.unknown()),
  trace: z
    .object({
      sessionId: z.string(),
      runId: z.string(),
      events: z.array(EvalRunTraceEventSchema),
    })
    .nullable(),
})

export type EvalRunArtifact = z.infer<typeof EvalRunArtifactSchema>
