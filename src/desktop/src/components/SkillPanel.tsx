import type { ComponentType, ReactNode } from "react"
import { Loader2, Sparkles, Star, Zap } from "lucide-react"
import type { DesktopSession, DesktopRun, DesktopSkillCatalogEntry } from "../view-types"
import { cn } from "../lib/utils"
import { filterSkillCatalog, getSkillActionState } from "./skill-state"

interface SkillPanelProps {
  skills: DesktopSkillCatalogEntry[]
  query: string
  session: DesktopSession | null
  activeRun?: DesktopRun
  busySkillName: string | null
  errorMessage: string | null
  warningMessage: string | null
  onStartSkill: (skillName: string) => void | Promise<unknown>
  onStopSkill: (skillName: string) => void | Promise<unknown>
  onSetDefaultSkill: (skillName: string) => void | Promise<unknown>
}

export function SkillPanel({
  skills,
  query,
  session,
  activeRun,
  busySkillName,
  errorMessage,
  warningMessage,
  onStartSkill,
  onStopSkill,
  onSetDefaultSkill,
}: SkillPanelProps) {
  const filteredSkills = filterSkillCatalog(skills, query)

  return (
    <div className="mb-3 overflow-hidden rounded-[1.35rem] border border-zinc-200 bg-white/95 shadow-[0_18px_48px_rgba(24,24,27,0.1)]">
      <div className="border-b border-zinc-200 bg-zinc-50/90 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p>Skills</p>
            <p className="truncate text-xs font-normal text-zinc-500">
              Browse and manage the active capabilities for this conversation.
            </p>
          </div>
        </div>
      </div>

      {warningMessage ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          {warningMessage}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-600">{errorMessage}</div>
      ) : null}

      <div className="max-h-72 overflow-y-auto p-2">
        {filteredSkills.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/80 px-4 py-6 text-sm text-zinc-500">
            {skills.length === 0
              ? "No `.agents/skills` were found in this workspace."
              : "No skills match this filter."}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredSkills.map((skill) => {
              const state = getSkillActionState({
                skillName: skill.name,
                session,
                activeRun,
              })
              const isBusy = busySkillName === skill.name

              return (
                <div
                  key={skill.path}
                  className="rounded-2xl border border-zinc-200 bg-zinc-50/60 px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold tracking-tight text-zinc-900">{skill.name}</h3>
                        {state.isActive ? (
                          <Badge icon={Zap} tone="active">
                            Active
                          </Badge>
                        ) : null}
                        {state.isDefault ? (
                          <Badge icon={Star} tone="default">
                            Default
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-zinc-600">{skill.description}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-zinc-400">{skill.path}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {state.canStart ? (
                        <ActionButton
                          disabled={isBusy}
                          onClick={() => void onStartSkill(skill.name)}
                          tone="primary"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Start
                        </ActionButton>
                      ) : null}

                      {state.canStop ? (
                        <ActionButton
                          disabled={isBusy}
                          onClick={() => void onStopSkill(skill.name)}
                          tone="secondary"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Stop
                        </ActionButton>
                      ) : null}

                      {state.canSetDefault ? (
                        <ActionButton
                          disabled={isBusy}
                          onClick={() => void onSetDefaultSkill(skill.name)}
                          tone="ghost"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Set Default
                        </ActionButton>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Badge(input: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  tone: "active" | "default"
}) {
  const Icon = input.icon

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        input.tone === "active"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-700",
      )}
    >
      <Icon className="h-3 w-3" />
      {input.children}
    </span>
  )
}

function ActionButton(input: {
  children: ReactNode
  disabled?: boolean
  onClick: () => void
  tone: "primary" | "secondary" | "ghost"
}) {
  return (
    <button
      type="button"
      disabled={input.disabled}
      onClick={input.onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        input.tone === "primary" && "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800",
        input.tone === "secondary" && "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100",
        input.tone === "ghost" && "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100",
      )}
    >
      {input.children}
    </button>
  )
}
