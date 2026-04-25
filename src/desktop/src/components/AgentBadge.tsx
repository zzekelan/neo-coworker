import React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "../lib/utils"

interface AgentBadgeProps {
  agentLabel: string
  isOpen: boolean
  onClick: () => void
}

function AgentBadgeComponent({ agentLabel, isOpen, onClick }: AgentBadgeProps) {
  return (
    <button
      type="button"
      data-testid="agent-badge"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
        isOpen
          ? "bg-surface text-ink"
          : "text-accent hover:bg-surface hover:text-ink",
      )}
    >
      <span className="h-2 w-2 rounded-full bg-highlight" aria-hidden="true" />
      {agentLabel}
      <ChevronDown
        className={cn(
          "h-3 w-3 text-muted transition-transform duration-150",
          isOpen && "rotate-180",
        )}
      />
    </button>
  )
}

export const AgentBadge = React.memo(AgentBadgeComponent)
