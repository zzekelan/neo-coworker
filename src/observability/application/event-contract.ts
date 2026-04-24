export const TELEMETRY_CONTRACT_EVENTS = {
  appStatePathResolved: "app_state_path_resolved",
  builtinSkillMaterialized: "builtin_skill_materialized",
  skillActivated: "skill_activated",
  agentSwitched: "agent_switched",
  deepResearchSubagentsPlanned: "deep_research_subagents_planned",
  researchArtifactWritten: "research_artifact_written",
} as const

export const TELEMETRY_CONTRACT_EVENT_NAMES = [
  TELEMETRY_CONTRACT_EVENTS.appStatePathResolved,
  TELEMETRY_CONTRACT_EVENTS.builtinSkillMaterialized,
  TELEMETRY_CONTRACT_EVENTS.skillActivated,
  TELEMETRY_CONTRACT_EVENTS.agentSwitched,
  TELEMETRY_CONTRACT_EVENTS.deepResearchSubagentsPlanned,
  TELEMETRY_CONTRACT_EVENTS.researchArtifactWritten,
] as const

export type TelemetryContractEventName = (typeof TELEMETRY_CONTRACT_EVENT_NAMES)[number]

export type SkillTelemetryContractEventName =
  | typeof TELEMETRY_CONTRACT_EVENTS.builtinSkillMaterialized
  | typeof TELEMETRY_CONTRACT_EVENTS.skillActivated

type AppStatePathRoot = "config" | "data" | "app-state"
type AppStatePathKind = "config" | "data" | "app-state" | "agents" | "server-db" | "desktop-state" | "desktop-settings"
type SkillSource = "builtin" | "global" | "workspace"
type AgentSwitchTrigger = "user" | "runtime" | "resume"
type ResearchSubagentKind = "web" | "docs" | "files" | "synthesis"
type ResearchArtifactKind =
  | "index"
  | "brief"
  | "findings"
  | "open-questions"
  | "sources-index"
  | "source"
  | "topic"
  | "finding"
  | "summary"
  | "plan"

export type AppStatePathResolvedPayload = {
  pathRoot: AppStatePathRoot
  pathKind: AppStatePathKind
  relativePath?: string
}

export type BuiltinSkillMaterializedPayload = {
  skillName: string
  packageRelativePath: string
  source: Extract<SkillSource, "builtin">
}

export type SkillActivatedPayload = {
  skillName: string
  activeSkillNames: string[]
  activeSkillCount: number
  source: SkillSource
}

type SkillActivatedPayloadInput = Omit<SkillActivatedPayload, "source"> & {
  source: string
}

export type AgentSwitchedPayload = {
  fromAgent: string | null
  toAgent: string
  trigger: AgentSwitchTrigger
}

export type DeepResearchSubagentsPlannedPayload = {
  topicSlug: string
  plannedCount: number
  subagentKinds: ResearchSubagentKind[]
}

export type ResearchArtifactWrittenPayload = {
  topicSlug: string
  artifactKind: ResearchArtifactKind
  workspaceRelativePath: string
}

export function createAppStatePathResolvedPayload(
  input: AppStatePathResolvedPayload,
): AppStatePathResolvedPayload {
  const payload: AppStatePathResolvedPayload = {
    pathRoot: input.pathRoot,
    pathKind: input.pathKind,
  }

  if (input.relativePath !== undefined) {
    payload.relativePath = assertSafeRelativePath(input.relativePath, "App state telemetry path")
  }

  return payload
}

export function createBuiltinSkillMaterializedPayload(
  input: BuiltinSkillMaterializedPayload,
): BuiltinSkillMaterializedPayload {
  return {
    skillName: normalizeLabel(input.skillName, "Skill name"),
    packageRelativePath: assertSafeRelativePath(
      input.packageRelativePath,
      "Skill materialization telemetry path",
    ),
    source: "builtin",
  }
}

export function createSkillActivatedPayload(input: SkillActivatedPayloadInput): SkillActivatedPayload {
  const activeSkillNames = input.activeSkillNames.map((skillName) =>
    normalizeLabel(skillName, "Active skill name"),
  )
  const activeSkillCount = assertNonNegativeInteger(input.activeSkillCount, "Active skill count")

  if (activeSkillCount !== activeSkillNames.length) {
    throw new Error("Active skill count must equal active skill names length.")
  }

  return {
    skillName: normalizeLabel(input.skillName, "Skill name"),
    activeSkillNames,
    activeSkillCount,
    source: normalizeSkillSource(input.source),
  }
}

export function createAgentSwitchedPayload(input: AgentSwitchedPayload): AgentSwitchedPayload {
  return {
    fromAgent: input.fromAgent === null ? null : normalizeLabel(input.fromAgent, "From agent"),
    toAgent: normalizeLabel(input.toAgent, "To agent"),
    trigger: input.trigger,
  }
}

export function createDeepResearchSubagentsPlannedPayload(
  input: DeepResearchSubagentsPlannedPayload,
): DeepResearchSubagentsPlannedPayload {
  const plannedCount = assertNonNegativeInteger(input.plannedCount, "Planned subagent count")

  if (plannedCount > 5) {
    throw new Error("Planned subagent count must be between 0 and 5.")
  }

  if (plannedCount !== input.subagentKinds.length) {
    throw new Error("Planned subagent count must equal subagent kinds length.")
  }

  return {
    topicSlug: normalizeSlug(input.topicSlug, "Topic slug"),
    plannedCount,
    subagentKinds: [...input.subagentKinds],
  }
}

export function createResearchArtifactWrittenPayload(
  input: ResearchArtifactWrittenPayload,
): ResearchArtifactWrittenPayload {
  const workspaceRelativePath = assertSafeRelativePath(
    input.workspaceRelativePath,
    "Research artifact telemetry path",
  )

  if (!workspaceRelativePath.startsWith(".ncoworker/research/")) {
    throw new Error("Research artifact telemetry path must be under .ncoworker/research/.")
  }

  return {
    topicSlug: normalizeSlug(input.topicSlug, "Topic slug"),
    artifactKind: input.artifactKind,
    workspaceRelativePath,
  }
}

function normalizeLabel(value: string, label: string) {
  const normalized = value.trim()

  if (normalized.length === 0) {
    throw new Error(`${label} is required.`)
  }

  return normalized
}

function normalizeSlug(value: string, label: string) {
  const normalized = normalizeLabel(value, label)

  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`${label} must be a safe slug.`)
  }

  return normalized
}

function normalizeSkillSource(value: string): SkillSource {
  if (value === "builtin" || value === "global" || value === "workspace") {
    return value
  }

  throw new Error("Skill source must be one of builtin, global, workspace.")
}

function assertNonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }

  return value
}

function assertSafeRelativePath(value: string, label: string) {
  const normalized = normalizeLabel(value.replace(/\\/g, "/"), label)

  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`${label} must be workspace-relative.`)
  }

  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty or traversal segments.`)
  }

  return normalized
}
