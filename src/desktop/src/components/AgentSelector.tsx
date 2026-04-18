import React from "react"
import { cn } from "../lib/utils"
import type { DesktopPrimaryAgent } from "../view-types"

interface AgentSelectorProps {
  isOpen: boolean
  agents: DesktopPrimaryAgent[]
  currentAgent: string
  onSelect: (agentName: string) => void
}

function AgentSelectorComponent({ isOpen, agents, currentAgent, onSelect }: AgentSelectorProps) {
  if (!isOpen) {
    return null
  }

  return (
    <div
      data-testid="agent-selector"
      className="absolute bottom-full left-0 mb-1 z-20"
    >
      <div className="min-w-[120px] overflow-hidden rounded-lg border border-border bg-paper shadow-md">
        {agents.map((agent) => (
          <button
            key={agent.name}
            type="button"
            data-testid={`agent-option-${agent.name}`}
            onClick={() => onSelect(agent.name)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
              agent.name === currentAgent
                ? "bg-highlight/10 font-medium text-highlight"
                : "text-ink hover:bg-surface",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                agent.name === currentAgent ? "bg-highlight" : "bg-muted/40",
              )}
              aria-hidden="true"
            />
            {agent.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export const AgentSelector = React.memo(AgentSelectorComponent)
