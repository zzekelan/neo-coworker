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

export const EvalTranscriptCheckpointSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "synthetic"]).optional(),
  partKinds: z.array(z.string()).default([]),
  textIncludes: z.array(z.string()).default([]),
  toolNames: z.array(z.string()).default([]),
})

export const EvalTranscriptExpectationSchema = z.object({
  orderedTextIncludes: z.array(z.string()).default([]),
  checkpoints: z.array(EvalTranscriptCheckpointSchema).default([]),
})

export const EvalTraceSequenceExpectationSchema = z.object({
  orderedEventTypes: z.array(z.string()).default([]),
})

export const EvalToolConsumptionRuleSchema = z.object({
  toolName: z.string().min(1),
  toolResultIncludes: z.array(z.string()).default([]),
  assistantTextIncludes: z.array(z.string()).default([]),
})

export const EvalToolConsumptionExpectationSchema = z.object({
  requiredConsumptions: z.array(EvalToolConsumptionRuleSchema).default([]),
})

export const EvalSkillDisclosureExpectationSchema = z.object({
  skillName: z.string().min(1),
  requireCatalogExposure: z.boolean().default(true),
  requireActivationEvent: z.boolean().default(true),
  requireLoadEvents: z.boolean().default(true),
  requireAbsentBeforeActivation: z.boolean().default(true),
  requirePresentAfterActivation: z.boolean().default(true),
  requirePromptChange: z.boolean().default(true),
})

export const EvalPromptAssemblyCheckpointSchema = z.object({
  promptIndex: z.number().int().nonnegative(),
  catalogSkillNamesIncludes: z.array(z.string()).default([]),
  activeSkillNamesIncludes: z.array(z.string()).default([]),
  activeSkillNamesExcludes: z.array(z.string()).default([]),
  activeSkillCount: z.number().int().nonnegative().optional(),
})

export const EvalPromptAssemblyExpectationSchema = z.object({
  checkpoints: z.array(EvalPromptAssemblyCheckpointSchema).default([]),
  requireDistinctActiveSkillSectionHashes: z.boolean().default(false),
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

export const EvalSessionSeedSchema = z.object({
  activeSkills: z.array(z.string().min(1)).default([]),
})

export const EvalTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  workspaceRoot: z.string().min(1),
  copyWorkspace: z.boolean().default(true),
  providerMode: EvalProviderModeSchema.default("scripted"),
  scenario: z.string().min(1).optional(),
  sessionSeed: EvalSessionSeedSchema.default({
    activeSkills: [],
  }),
  permissionPolicy: z
    .object({
      write: EvalPermissionModeSchema.optional(),
      edit: EvalPermissionModeSchema.optional(),
      shell: EvalPermissionModeSchema.optional(),
      webfetch: EvalPermissionModeSchema.optional(),
      websearch: EvalPermissionModeSchema.optional(),
      codesearch: EvalPermissionModeSchema.optional(),
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
  transcriptExpectation: EvalTranscriptExpectationSchema.default({
    orderedTextIncludes: [],
    checkpoints: [],
  }),
  traceSequenceExpectation: EvalTraceSequenceExpectationSchema.default({
    orderedEventTypes: [],
  }),
  toolConsumptionExpectation: EvalToolConsumptionExpectationSchema.default({
    requiredConsumptions: [],
  }),
  skillDisclosureExpectation: EvalSkillDisclosureExpectationSchema.optional(),
  promptAssemblyExpectation: EvalPromptAssemblyExpectationSchema.default({
    checkpoints: [],
    requireDistinctActiveSkillSectionHashes: false,
  }),
})

export type EvalTask = z.infer<typeof EvalTaskSchema>
export type EvalProviderMode = z.infer<typeof EvalProviderModeSchema>
export type EvalTraceExpectation = z.infer<typeof EvalTraceExpectationSchema>
export type EvalTranscriptExpectation = z.infer<typeof EvalTranscriptExpectationSchema>
export type EvalTraceSequenceExpectation = z.infer<typeof EvalTraceSequenceExpectationSchema>
export type EvalOutcomeExpectation = z.infer<typeof EvalOutcomeExpectationSchema>
export type EvalProtocolExpectation = z.infer<typeof EvalProtocolExpectationSchema>
export type EvalToolPolicyExpectation = z.infer<typeof EvalToolPolicyExpectationSchema>
export type EvalToolConsumptionExpectation = z.infer<typeof EvalToolConsumptionExpectationSchema>
export type EvalSkillDisclosureExpectation = z.infer<typeof EvalSkillDisclosureExpectationSchema>
export type EvalPromptAssemblyExpectation = z.infer<typeof EvalPromptAssemblyExpectationSchema>
