import { z } from "zod"

export const EvalPermissionDecisionSchema = z.enum(["allow", "deny"])
export const EvalPermissionModeSchema = z.enum(["allow", "deny", "ask"])

export const EvalTraceExpectationSchema = z.object({
  requiredEventTypes: z.array(z.string()).default([]),
})

export const EvalTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  workspaceRoot: z.string().min(1),
  copyWorkspace: z.boolean().default(true),
  permissionPolicy: z
    .object({
      write: EvalPermissionModeSchema.optional(),
      edit: EvalPermissionModeSchema.optional(),
      shell: EvalPermissionModeSchema.optional(),
    })
    .default({}),
  autoReplyPermission: EvalPermissionDecisionSchema.optional(),
  traceExpectation: EvalTraceExpectationSchema.default({
    requiredEventTypes: [],
  }),
})

export type EvalTask = z.infer<typeof EvalTaskSchema>
export type EvalTraceExpectation = z.infer<typeof EvalTraceExpectationSchema>
