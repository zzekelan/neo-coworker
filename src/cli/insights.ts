import type { InsightsSummary, SessionInsight } from "../bootstrap"

const DEFAULT_TOP_TOOL_COUNT = 3

export const DEFAULT_CLI_INSIGHTS_LIMIT = 20

export function formatSessionInsightsReport(input: {
  insights: SessionInsight[]
  summary: InsightsSummary
}) {
  const lines = [
    "Session insights",
    `Sessions: ${input.summary.totalSessions} | Tokens (input/output/total): ${formatTokenUsage(
      input.summary.totalTokens,
    )} | Avg turns/session: ${formatAverage(input.summary.avgTurnsPerSession)} | Top tools: ${formatSummaryTopTools(
      input.summary.topTools,
    )}`,
  ]

  if (input.insights.length === 0) {
    lines.push("No sessions found.")
    return `${lines.join("\n")}\n`
  }

  lines.push("")
  lines.push("sessionId | tokens (input/output/total) | turns | top tools")

  for (const insight of input.insights) {
    lines.push(formatSessionInsightRow(insight))
  }

  return `${lines.join("\n")}\n`
}

function formatSessionInsightRow(insight: SessionInsight) {
  return [
    insight.sessionId,
    formatTokenUsage(insight.totalTokens),
    String(insight.turnCount),
    formatInsightTopTools(insight),
  ].join(" | ")
}

function formatTokenUsage(tokens: { input: number; output: number }) {
  return `${tokens.input}/${tokens.output}/${tokens.input + tokens.output}`
}

function formatSummaryTopTools(topTools: InsightsSummary["topTools"]) {
  if (topTools.length === 0) {
    return "none"
  }

  return topTools.slice(0, DEFAULT_TOP_TOOL_COUNT).map(formatNamedToolCount).join(", ")
}

function formatInsightTopTools(insight: SessionInsight) {
  const topTools = [...insight.toolUsage.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))

  if (topTools.length === 0) {
    return "none"
  }

  return topTools.slice(0, DEFAULT_TOP_TOOL_COUNT).map(formatNamedToolCount).join(", ")
}

function formatNamedToolCount(tool: { name: string; count: number }) {
  return `${tool.name}×${tool.count}`
}

function formatAverage(value: number) {
  if (Number.isInteger(value)) {
    return String(value)
  }

  return value.toFixed(1)
}
