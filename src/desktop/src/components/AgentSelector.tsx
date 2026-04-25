import React from "react"
import { Check } from "lucide-react"
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
      className="absolute bottom-full left-0 mb-2 z-20"
    >
      <div className="min-w-[180px] overflow-hidden rounded-lg border border-border bg-paper shadow-xl ring-1 ring-ink/5">
        <div className="py-1">
          {agents.map((agent) => {
            const isActive = agent.name === currentAgent
            const agentLabel = agent.displayName || agent.name
            return (
              <button
                key={agent.name}
                type="button"
                data-testid={`agent-option-${agent.name}`}
                onClick={() => onSelect(agent.name)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                  isActive
                    ? "bg-highlight/8"
                    : "hover:bg-surface",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                    isActive
                      ? "bg-highlight text-paper"
                      : "border border-muted/60",
                  )}
                  aria-hidden="true"
                >
                  {isActive ? <Check className="h-2.5 w-2.5" /> : null}
                </span>
                <span
                  className={cn(
                    "text-[13px] font-medium",
                    isActive ? "text-ink" : "text-ink/80",
                  )}
                >
                  {agentLabel}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export const AgentSelector = React.memo(AgentSelectorComponent)
