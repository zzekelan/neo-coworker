import React from "react"
import { cn } from "../lib/utils"

interface AgentBadgeProps {
  agentName: string
  isOpen: boolean
  onClick: () => void
}

function AgentBadgeComponent({ agentName, isOpen, onClick }: AgentBadgeProps) {
  return (
    <button
      type="button"
      data-testid="agent-badge"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        isOpen
          ? "bg-surface text-ink"
          : "text-accent hover:bg-surface hover:text-ink",
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-highlight" aria-hidden="true" />
      {agentName}
    </button>
  )
}

export const AgentBadge = React.memo(AgentBadgeComponent)
