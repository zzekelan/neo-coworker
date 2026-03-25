import { z } from "zod"
import { EvalProviderModeSchema, EvalRunStatusSchema } from "./task"

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

export const EvalObservedFileSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  content: z.string().nullable(),
})

export const EvalProviderInfoSchema = z.object({
  mode: EvalProviderModeSchema,
  kind: z.string(),
  model: z.string().nullable(),
})

export const EvalOutcomeSchema = z.object({
  runStatus: EvalRunStatusSchema,
  errorText: z.string().nullable(),
  watchedFiles: z.array(EvalObservedFileSchema),
})

export const EvalMetricsSchema = z.object({
  totalRunDurationMs: z.number().int().nonnegative().nullable(),
  modelTurnCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  permissionWaitCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  terminalEventType: z.enum(["run.completed", "run.failed", "run.cancelled"]).nullable(),
})

export const EvalRunArtifactSchema = z.object({
  taskId: z.string(),
  workspaceRoot: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  provider: EvalProviderInfoSchema,
  runStatus: EvalRunStatusSchema,
  runtimeEvents: z.array(EvalRuntimeEventSchema),
  transcript: z.array(z.unknown()),
  trace: z
    .object({
      sessionId: z.string(),
      runId: z.string(),
      events: z.array(EvalRunTraceEventSchema),
    })
    .nullable(),
  outcome: EvalOutcomeSchema,
  metrics: EvalMetricsSchema,
})

export type EvalRunArtifact = z.infer<typeof EvalRunArtifactSchema>
export type EvalProviderInfo = z.infer<typeof EvalProviderInfoSchema>
