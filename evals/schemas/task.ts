import { z } from "zod"

export const EvalPermissionDecisionSchema = z.enum(["allow", "deny"])
export const EvalPermissionModeSchema = z.enum(["allow", "deny", "ask"])
export const EvalProviderModeSchema = z.enum(["scripted", "live"])
export const EvalRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
])

export const EvalTraceExpectationSchema = z.object({
  requiredEventTypes: z.array(z.string()).default([]),
})

export const EvalOutcomeFileExpectationSchema = z.object({
  path: z.string().min(1),
  shouldExist: z.boolean().default(true),
  contentIncludes: z.string().min(1).optional(),
})

export const EvalOutcomeExpectationSchema = z.object({
  runStatus: EvalRunStatusSchema,
  errorIncludes: z.string().min(1).optional(),
  watchedFiles: z.array(EvalOutcomeFileExpectationSchema).default([]),
})

export const EvalProtocolExpectationSchema = z.object({
  requiredRuntimeEventTypes: z.array(z.string()).default([]),
  forbiddenRuntimeEventTypes: z.array(z.string()).default([]),
})

export const EvalToolPolicyExpectationSchema = z.object({
  requiredToolNames: z.array(z.string()).default([]),
  forbiddenToolNames: z.array(z.string()).default([]),
})

export const EvalControlSchema = z.object({
  cancelOnRuntimeEventType: z.string().min(1).optional(),
})

export const EvalTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  workspaceRoot: z.string().min(1),
  copyWorkspace: z.boolean().default(true),
  providerMode: EvalProviderModeSchema.default("scripted"),
  scenario: z.string().min(1).optional(),
  permissionPolicy: z
    .object({
      write: EvalPermissionModeSchema.optional(),
      edit: EvalPermissionModeSchema.optional(),
      shell: EvalPermissionModeSchema.optional(),
    })
    .default({}),
  autoReplyPermission: EvalPermissionDecisionSchema.optional(),
  control: EvalControlSchema.default({}),
  outcomeExpectation: EvalOutcomeExpectationSchema.default({
    runStatus: "completed",
    watchedFiles: [],
  }),
  protocolExpectation: EvalProtocolExpectationSchema.default({
    requiredRuntimeEventTypes: [],
    forbiddenRuntimeEventTypes: [],
  }),
  toolPolicyExpectation: EvalToolPolicyExpectationSchema.default({
    requiredToolNames: [],
    forbiddenToolNames: [],
  }),
  traceExpectation: EvalTraceExpectationSchema.default({
    requiredEventTypes: [],
  }),
})

export type EvalTask = z.infer<typeof EvalTaskSchema>
export type EvalProviderMode = z.infer<typeof EvalProviderModeSchema>
export type EvalTraceExpectation = z.infer<typeof EvalTraceExpectationSchema>
export type EvalOutcomeExpectation = z.infer<typeof EvalOutcomeExpectationSchema>
export type EvalProtocolExpectation = z.infer<typeof EvalProtocolExpectationSchema>
export type EvalToolPolicyExpectation = z.infer<typeof EvalToolPolicyExpectationSchema>
