export type SessionInsight = {
  sessionId: string
  startedAt: Date
  endedAt?: Date
  totalTokens: {
    input: number
    output: number
  }
  toolUsage: Map<string, number>
  turnCount: number
  compactionCount: number
}

export type InsightsQuery = {
  from?: Date
  to?: Date
  sessionIds?: string[]
  limit?: number
}

export type InsightsSummary = {
  totalSessions: number
  totalTokens: {
    input: number
    output: number
  }
  topTools: Array<{ name: string; count: number }>
  avgTurnsPerSession: number
  avgTokensPerSession: number
}

export type InsightsPort = {
  getSessionInsight(sessionId: string): Promise<SessionInsight | null>
  querySessions(query: InsightsQuery): Promise<SessionInsight[]>
  summarize(insights: SessionInsight[]): InsightsSummary
}

export function summarizeSessionInsights(insights: SessionInsight[]): InsightsSummary {
  if (insights.length === 0) {
    return createEmptyInsightsSummary()
  }

  const toolCounts = new Map<string, number>()
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTurns = 0

  for (const insight of insights) {
    totalInputTokens += insight.totalTokens.input
    totalOutputTokens += insight.totalTokens.output
    totalTurns += insight.turnCount

    for (const [toolName, count] of insight.toolUsage) {
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + count)
    }
  }

  const totalSessions = insights.length
  const totalTokens = totalInputTokens + totalOutputTokens

  return {
    totalSessions,
    totalTokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
    },
    topTools: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    avgTurnsPerSession: totalTurns / totalSessions,
    avgTokensPerSession: totalTokens / totalSessions,
  }
}

function createEmptyInsightsSummary(): InsightsSummary {
  return {
    totalSessions: 0,
    totalTokens: {
      input: 0,
      output: 0,
    },
    topTools: [],
    avgTurnsPerSession: 0,
    avgTokensPerSession: 0,
  }
}
