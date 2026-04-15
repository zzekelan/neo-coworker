import {
  assessCommandRisk,
  RiskLevel,
  type PermissionMode,
  type PermissionRequest,
  type RiskAssessment,
} from "../domain"

const SAFE_EXPLANATION = "No known dangerous patterns detected."
const REASON_SNIPPET_LIMIT = 120

type SensitivePathRule = {
  label: string
  pattern: RegExp
  explanation: string
}

const SENSITIVE_PATH_RULES: SensitivePathRule[] = [
  {
    label: "environment file path",
    pattern: /(^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/i,
    explanation: "Targets an environment file that may contain secrets.",
  },
  {
    label: "ssh directory path",
    pattern: /(?:^|\/|~\/|\.\/|\.\.\/)(?:[^\s]+\/)?\.ssh(?:\/|$)/i,
    explanation: "Targets an SSH configuration or private-key path.",
  },
  {
    label: "system /etc path",
    pattern: /^\/etc(?:\/|$)/i,
    explanation: "Targets a system configuration path under /etc.",
  },
]

export type RiskAssessmentContext = {
  sessionId: string
  runId: string
}

export type RiskAssessmentObserverEvent =
  | {
      type: "risk.assessed"
      sessionId: string
      runId: string
      toolName: string
      riskLevel: RiskLevel
      patterns: string[]
      reasonSnippet: string
    }
  | {
      type: "permission.dangerous_override"
      sessionId: string
      runId: string
      toolName: string
      originalMode: PermissionMode
      riskLevel: RiskLevel
    }

export type RiskAssessmentObserver = {
  recordPermissionEvent?(event: RiskAssessmentObserverEvent): void
}

export class RiskAssessmentService {
  constructor(
    private readonly analyzer: typeof assessCommandRisk = assessCommandRisk,
    private readonly observer?: RiskAssessmentObserver,
  ) {}

  assessFromPermissionRequest(
    request: PermissionRequest,
    context?: RiskAssessmentContext,
  ): RiskAssessment {
    const assessment = assessRiskFromPermissionRequest(request, this.analyzer)

    if (context != null) {
      this.emitEvent({
        type: "risk.assessed",
        sessionId: context.sessionId,
        runId: context.runId,
        toolName: request.toolName,
        riskLevel: assessment.level,
        patterns: assessment.patterns,
        reasonSnippet: createReasonSnippet(request.reason),
      })
    }

    return assessment
  }

  resolveModeForRequest(input: {
    request: PermissionRequest
    originalMode: PermissionMode
    sessionId?: string
    runId?: string
  }): PermissionMode {
    const context =
      input.sessionId != null && input.runId != null
        ? {
            sessionId: input.sessionId,
            runId: input.runId,
          }
        : undefined
    const assessment = this.assessFromPermissionRequest(input.request, context)

    if (input.originalMode !== "allow" || assessment.level === RiskLevel.SAFE) {
      return input.originalMode
    }

    if (context != null) {
      this.emitEvent({
        type: "permission.dangerous_override",
        sessionId: context.sessionId,
        runId: context.runId,
        toolName: input.request.toolName,
        originalMode: input.originalMode,
        riskLevel: assessment.level,
      })
    }

    return "ask"
  }

  private emitEvent(event: RiskAssessmentObserverEvent) {
    try {
      this.observer?.recordPermissionEvent?.(event)
    } catch {
    }
  }
}

function assessRiskFromPermissionRequest(
  request: PermissionRequest,
  analyzer: typeof assessCommandRisk,
): RiskAssessment {
  switch (request.toolName) {
    case "shell":
      return analyzer(stripReasonPrefix(request.reason, "shell"))
    case "write":
    case "edit":
      return assessSensitivePathRisk(stripReasonPrefix(request.reason, request.toolName))
    default:
      return createSafeAssessment()
  }
}

function assessSensitivePathRisk(path: string): RiskAssessment {
  const normalizedPath = normalizePath(path)

  if (normalizedPath.length === 0) {
    return createSafeAssessment()
  }

  const matches = SENSITIVE_PATH_RULES.filter((rule) => rule.pattern.test(normalizedPath))

  if (matches.length === 0) {
    return createSafeAssessment()
  }

  return {
    level: RiskLevel.DANGEROUS,
    patterns: matches.map((match) => match.label),
    explanation: matches[0]!.explanation,
  }
}

function stripReasonPrefix(reason: string, prefix: string): string {
  const normalizedReason = reason.trim()
  const prefixPattern = new RegExp(`^${prefix}\\s+`, "i")

  if (prefixPattern.test(normalizedReason)) {
    return normalizedReason.replace(prefixPattern, "").trim()
  }

  return normalizedReason
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/")
}

function createReasonSnippet(reason: string): string {
  return reason.trim().slice(0, REASON_SNIPPET_LIMIT)
}

function createSafeAssessment(): RiskAssessment {
  return {
    level: RiskLevel.SAFE,
    patterns: [],
    explanation: SAFE_EXPLANATION,
  }
}
