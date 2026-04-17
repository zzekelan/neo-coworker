import { z } from "zod"
import {
  EvalProviderModeSchema,
  EvalRunStatusSchema,
  EvalTokenUsageSourceSchema,
} from "./task"

export const EvalRunTraceEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  source: z.enum(["model", "orchestration", "permission", "tool", "memory", "skill"]),
  eventType: z.string(),
  createdAt: z.number().int(),
  data: z.record(z.string(), z.unknown()),
})

export const EvalRuntimeEventSchema = z.object({
  type: z.string(),
})

export const EvalRunTraceSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  events: z.array(EvalRunTraceEventSchema),
})

export const EvalArtifactRunSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  runId: z.string(),
  trigger: z.string(),
  status: EvalRunStatusSchema,
  errorText: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  tokenUsageSource: EvalTokenUsageSourceSchema.nullable(),
  runtimeEvents: z.array(EvalRuntimeEventSchema),
  trace: EvalRunTraceSchema.nullable(),
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
  trace: EvalRunTraceSchema.nullable(),
  runs: z.array(EvalArtifactRunSchema),
  outcome: EvalOutcomeSchema,
  metrics: EvalMetricsSchema,
})

export type EvalRunArtifact = z.infer<typeof EvalRunArtifactSchema>
export type EvalProviderInfo = z.infer<typeof EvalProviderInfoSchema>
