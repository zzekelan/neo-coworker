import { z } from "zod"

export const EvalPermissionDecisionSchema = z.enum(["allow", "deny"])
export const EvalPermissionModeSchema = z.enum(["allow", "deny", "ask"])
export const EvalProviderModeSchema = z.enum(["scripted", "live"])
export const EvalTokenUsageSourceSchema = z.enum(["provider", "estimated"])
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
  catalogSkillNamesExcludes: z.array(z.string()).default([]),
  activeSkillNamesIncludes: z.array(z.string()).default([]),
  activeSkillNamesExcludes: z.array(z.string()).default([]),
  recoveryFilePathsIncludes: z.array(z.string()).default([]),
  recoveryFilePathsExcludes: z.array(z.string()).default([]),
  activeSkillCount: z.number().int().nonnegative().optional(),
})

export const EvalPromptAssemblyExpectationSchema = z.object({
  checkpoints: z.array(EvalPromptAssemblyCheckpointSchema).default([]),
  requireStableSystemPromptHash: z.boolean().default(false),
  requireDistinctSystemReminderHashes: z.boolean().default(false),
})

export const EvalTraceDataFieldExpectationSchema = z.object({
  field: z.string().min(1),
  valueType: z.enum(["string", "number", "boolean"]).optional(),
  equalsString: z.string().min(1).optional(),
  equalsNumber: z.number().optional(),
  equalsBoolean: z.boolean().optional(),
  greaterThanNumber: z.number().optional(),
  lessThanNumber: z.number().optional(),
  includes: z.string().min(1).optional(),
})

export const EvalTraceDataEventExpectationSchema = z.object({
  runIndex: z.number().int().nonnegative().optional(),
  eventType: z.string().min(1),
  fields: z.array(EvalTraceDataFieldExpectationSchema).default([]),
})

export const EvalTraceDataExpectationSchema = z.object({
  events: z.array(EvalTraceDataEventExpectationSchema).default([]),
})

export const EvalRunRecordCheckpointSchema = z.object({
  runIndex: z.number().int().nonnegative(),
  trigger: z.string().min(1).optional(),
  status: EvalRunStatusSchema.optional(),
  minInputTokens: z.number().int().nonnegative().optional(),
  minOutputTokens: z.number().int().nonnegative().optional(),
  tokenUsageSources: z.array(EvalTokenUsageSourceSchema).default([]),
})

export const EvalRunRecordsExpectationSchema = z.object({
  checkpoints: z.array(EvalRunRecordCheckpointSchema).default([]),
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

export const EvalProviderFaultsSchema = z.object({
  summarizeFailures: z.number().int().nonnegative().default(0),
  summarizeFailureMessage: z.string().min(1).default("Injected summarize failure"),
})

export const EvalTaskStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    prompt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("command"),
    command: z.enum(["compact"]),
  }),
])

export const EvalTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  workspaceRoot: z.string().min(1),
  copyWorkspace: z.boolean().default(true),
  contextWindow: z.number().int().positive().optional(),
  providerMode: EvalProviderModeSchema.default("scripted"),
  scenario: z.string().min(1).optional(),
  steps: z.array(EvalTaskStepSchema).default([]),
  sessionSeed: EvalSessionSeedSchema.default({
    activeSkills: [],
  }),
  providerFaults: EvalProviderFaultsSchema.default({
    summarizeFailures: 0,
    summarizeFailureMessage: "Injected summarize failure",
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
    requireStableSystemPromptHash: false,
    requireDistinctSystemReminderHashes: false,
  }),
  traceDataExpectation: EvalTraceDataExpectationSchema.default({
    events: [],
  }),
  runRecordsExpectation: EvalRunRecordsExpectationSchema.default({
    checkpoints: [],
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
export type EvalTraceDataExpectation = z.infer<typeof EvalTraceDataExpectationSchema>
export type EvalRunRecordsExpectation = z.infer<typeof EvalRunRecordsExpectationSchema>
export type EvalTaskStep = z.infer<typeof EvalTaskStepSchema>
