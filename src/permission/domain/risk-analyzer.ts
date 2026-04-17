export enum RiskLevel {
  SAFE = "safe",
  MODERATE = "moderate",
  DANGEROUS = "dangerous",
  CRITICAL = "critical",
}

export type RiskAssessment = {
  level: RiskLevel
  patterns: string[]
  explanation: string
}

const RISK_PRIORITY: Record<RiskLevel, number> = {
  [RiskLevel.SAFE]: 0,
  [RiskLevel.MODERATE]: 1,
  [RiskLevel.DANGEROUS]: 2,
  [RiskLevel.CRITICAL]: 3,
}

const RISK_RULES: Array<{
  level: Exclude<RiskLevel, RiskLevel.SAFE>
  label: string
  pattern: RegExp
  explanation: string
}> = [
  {
    level: RiskLevel.CRITICAL,
    label: "recursive root delete",
    pattern: /\brm\s+-[^\s;|&]*[rf][^\s;|&]*\s+\/$/i,
    explanation: "Deletes from the filesystem root recursively.",
  },
  {
    level: RiskLevel.DANGEROUS,
    label: "recursive delete",
    pattern: /\brm\s+-[^\s;|&]*[rf][^\s;|&]*\s+(?:~\/|\.\.?\/|\/)[^\s;|&]+/i,
    explanation: "Deletes a filesystem path recursively.",
  },
  {
    level: RiskLevel.CRITICAL,
    label: "filesystem formatting",
    pattern: /\bmkfs(?:\.[^\s;|&]+)?\b/i,
    explanation: "Formats a filesystem or block device.",
  },
  {
    level: RiskLevel.CRITICAL,
    label: "raw disk write",
    pattern: /\bdd\b.*(?:\bof=\/dev\/|>\s*\/dev\/sd)/i,
    explanation: "Writes raw data to a device.",
  },
  {
    level: RiskLevel.DANGEROUS,
    label: "world-writable permissions",
    pattern: /\bchmod\s+(?:-[^\s]+\s+)*(?:777|666)\b/i,
    explanation: "Sets insecure world-writable permissions.",
  },
  {
    level: RiskLevel.DANGEROUS,
    label: "ssh private key access",
    pattern: /(?:^|[;&|]\s*|&&\s*|\|\|\s*)(?:cat|less|more|head|tail|cp|scp)\b[^\n]*?(?:~\/|\.?\.\/)?\.ssh\/(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)\b/i,
    explanation: "Reads or copies a private SSH key.",
  },
  {
    level: RiskLevel.DANGEROUS,
    label: "force push",
    pattern: /\bgit\s+push\b[^\n]*\s(?:--force|-f)(?:\s|$)/i,
    explanation: "Rewrites remote Git history with force push.",
  },
  {
    level: RiskLevel.MODERATE,
    label: "environment file access",
    pattern: /(?:^|[;&|]\s*|&&\s*|\|\|\s*)(?:cat|less|more|head|tail|grep)\b[^\n]*?(?:^|\s|\/)(?:\.env(?:\.[A-Za-z0-9_-]+)?)\b/i,
    explanation: "Reads an environment file that may contain secrets.",
  },
]

export const DANGEROUS_PATTERNS = RISK_RULES.map((rule) => rule.pattern)

export function assessCommandRisk(command: string): RiskAssessment {
  const normalizedCommand = command.trim()

  if (normalizedCommand.length === 0) {
    return {
      level: RiskLevel.SAFE,
      patterns: [],
      explanation: "No known dangerous patterns detected.",
    }
  }

  const matches = RISK_RULES.filter((rule) => rule.pattern.test(normalizedCommand))

  if (matches.length === 0) {
    return {
      level: RiskLevel.SAFE,
      patterns: [],
      explanation: "No known dangerous patterns detected.",
    }
  }

  const highestRiskMatch = matches.reduce((currentHighest, candidate) => {
    if (RISK_PRIORITY[candidate.level] > RISK_PRIORITY[currentHighest.level]) {
      return candidate
    }

    return currentHighest
  })

  return {
    level: highestRiskMatch.level,
    patterns: matches.map((match) => match.label),
    explanation: highestRiskMatch.explanation,
  }
}
