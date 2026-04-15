export type SkillThreatType =
  | "injection"
  | "exfiltration"
  | "system_override"
  | "obfuscation"

export type SkillThreatSeverity = "low" | "medium" | "high" | "critical"

export type SkillThreat = {
  type: SkillThreatType
  pattern: string
  severity: SkillThreatSeverity
}

export type ScanResult = {
  safe: boolean
  threats: SkillThreat[]
}

type SkillThreatDefinition = SkillThreat & {
  test: RegExp
}

const INVISIBLE_UNICODE_CHARACTERS = [
  "\u200b",
  "\u200c",
  "\u200d",
  "\u2060",
  "\ufeff",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
] as const

const SKILL_THREAT_PATTERNS: SkillThreatDefinition[] = [
  {
    type: "injection",
    pattern: "ignore previous instructions",
    severity: "high",
    test: /\bignore\s+(?:the\s+)?(?:previous|prior|above|earlier|all)\s+(?:system\s+)?(?:instructions?|prompts?|directives?|rules?)\b/i,
  },
  {
    type: "injection",
    pattern: "you are now",
    severity: "low",
    test: /\byou\s+are\s+now\b/i,
  },
  {
    type: "system_override",
    pattern: "system prompt override",
    severity: "critical",
    test: /\bsystem\s+prompt\s+override\b/i,
  },
  {
    type: "system_override",
    pattern: "modify system prompt",
    severity: "critical",
    test: /\b(?:override|replace|modify|rewrite|change)\s+(?:the\s+)?(?:system\s+prompt|developer\s+message)\b/i,
  },
  {
    type: "system_override",
    pattern: "modify tool definitions",
    severity: "high",
    test: /\b(?:override|replace|modify|rewrite|change)\s+(?:the\s+)?(?:tool\s+definitions?|tool\s+schema|available\s+tools?)\b/i,
  },
  {
    type: "exfiltration",
    pattern: "curl to external URL",
    severity: "critical",
    test: /\bcurl\b[^\n]*(?:https?:\/\/|www\.)/i,
  },
  {
    type: "exfiltration",
    pattern: "wget to external URL",
    severity: "critical",
    test: /\bwget\b[^\n]*(?:https?:\/\/|www\.)/i,
  },
  {
    type: "exfiltration",
    pattern: "base64 encode environment secrets",
    severity: "high",
    test: /(?:\b(?:env|printenv)\b|\bcat\s+[^\n]*(?:\.env|credentials|secrets?)\b|\b(?:echo|printf)\b[^\n]*\$[{(]?[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*[})]?)[^\n|;]{0,160}\|\s*base64\b/i,
  },
  {
    type: "obfuscation",
    pattern: "base64 decoded command",
    severity: "high",
    test: /\b(?:echo|printf)\b[^\n]*[A-Za-z0-9+/]{20,}={0,2}[^\n|;]{0,80}\|\s*base64(?:\s+--decode|\s+-d)\b/i,
  },
  {
    type: "obfuscation",
    pattern: "hex encoded string",
    severity: "medium",
    test: /(?:\\x[0-9a-fA-F]{2}){4,}|(?:0x[0-9a-fA-F]{2}[,\s]*){4,}/i,
  },
]

export function scanSkillContent(content: string): ScanResult {
  const threats: SkillThreat[] = []

  if (containsInvisibleUnicode(content)) {
    threats.push({
      type: "obfuscation",
      pattern: "invisible unicode",
      severity: "medium",
    })
  }

  if (containsMixedScriptToken(content)) {
    threats.push({
      type: "obfuscation",
      pattern: "mixed-script homoglyphs",
      severity: "medium",
    })
  }

  for (const threat of SKILL_THREAT_PATTERNS) {
    if (threat.test.test(content)) {
      threats.push({
        type: threat.type,
        pattern: threat.pattern,
        severity: threat.severity,
      })
    }
  }

  return {
    safe: threats.length === 0,
    threats,
  }
}

function containsInvisibleUnicode(content: string) {
  return INVISIBLE_UNICODE_CHARACTERS.some((character) => content.includes(character))
}

function containsMixedScriptToken(content: string) {
  const tokens = content.match(/[^\s]+/gu) ?? []

  return tokens.some(
    (token) => /[A-Za-z]/.test(token) && /[\u0370-\u03ff\u0400-\u04ff]/u.test(token),
  )
}
