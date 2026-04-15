const MEMORY_THREAT_PATTERNS = [
  {
    id: "prompt_injection",
    pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i,
  },
  {
    id: "role_hijack",
    pattern: /you\s+are\s+now\s+/i,
  },
  {
    id: "deception_hide",
    pattern: /do\s+not\s+tell\s+the\s+user/i,
  },
  {
    id: "sys_prompt_override",
    pattern: /system\s+prompt\s+override/i,
  },
  {
    id: "disregard_rules",
    pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i,
  },
  {
    id: "bypass_restrictions",
    pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
  },
  {
    id: "exfil_curl",
    pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  },
  {
    id: "exfil_wget",
    pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
  },
  {
    id: "read_secrets",
    pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
  },
  {
    id: "ssh_backdoor",
    pattern: /authorized_keys/i,
  },
  {
    id: "ssh_access",
    pattern: /(\$HOME\/\.ssh|~\/\.ssh)/i,
  },
  {
    id: "hermes_env",
    pattern: /(\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env)/i,
  },
] as const

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
]

export function scanForInjection(content: string) {
  const threats: string[] = []

  if (INVISIBLE_UNICODE_CHARACTERS.some((character) => content.includes(character))) {
    threats.push("invisible_unicode")
  }

  for (const threat of MEMORY_THREAT_PATTERNS) {
    if (threat.pattern.test(content)) {
      threats.push(threat.id)
    }
  }

  return {
    safe: threats.length === 0,
    threats,
  }
}
