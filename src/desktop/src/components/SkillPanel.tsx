import type { ComponentType, ReactNode } from "react"
import { Loader2, Sparkles, Star, Zap } from "lucide-react"
import type { DesktopSession, DesktopRun, DesktopSkillCatalogEntry } from "../view-types"
import { cn } from "../lib/utils"
import { useDesktopText } from "../i18n"
import { filterSkillCatalog, getSkillActionState } from "./skill-state"

interface SkillPanelProps {
  skills: DesktopSkillCatalogEntry[]
  query: string
  session: DesktopSession | null
  activeRun?: DesktopRun
  controlsDisabled: boolean
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
  controlsDisabled,
  busySkillName,
  errorMessage,
  warningMessage,
  onStartSkill,
  onStopSkill,
  onSetDefaultSkill,
}: SkillPanelProps) {
  const text = useDesktopText()
  const filteredSkills = filterSkillCatalog(skills, query)

  return (
    <div className="mb-3 overflow-hidden rounded-[1.35rem] border border-border bg-paper shadow-[0_18px_48px_rgba(24,24,27,0.1)]">
      <div className="border-b border-border bg-paper px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-paper text-ink shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p>{text.skillPanel.title}</p>
            <p className="truncate text-xs font-normal text-muted">
              {text.skillPanel.subtitle}
            </p>
          </div>
        </div>
      </div>

      {warningMessage ? (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-500">
          {warningMessage}
        </div>
      ) : null}

      {controlsDisabled ? (
        <div className="border-b border-highlight/30 bg-highlight/10 px-4 py-2 text-sm text-highlight">
          {text.skillPanel.locked}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="border-b border-danger bg-danger/10 px-4 py-2 text-sm text-danger">{errorMessage}</div>
      ) : null}

      <div className="max-h-72 overflow-y-auto p-2">
        {filteredSkills.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-paper px-4 py-6 text-sm text-muted">
            {skills.length === 0
              ? text.skillPanel.noWorkspaceSkills
              : text.skillPanel.noFilteredSkills}
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
                  className="rounded-2xl border border-border bg-paper px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold tracking-tight text-ink">{skill.name}</h3>
                        {state.isActive ? (
                          <Badge icon={Zap} tone="active">
                            {text.skillPanel.active}
                          </Badge>
                        ) : null}
                        {state.isDefault ? (
                          <Badge icon={Star} tone="default">
                            {text.skillPanel.default}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-muted">{skill.description}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-accent">{skill.path}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {state.canStart ? (
                        <ActionButton
                          disabled={isBusy || controlsDisabled}
                          onClick={() => void onStartSkill(skill.name)}
                          tone="primary"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          {text.skillPanel.start}
                        </ActionButton>
                      ) : null}

                      {state.canStop ? (
                        <ActionButton
                          disabled={isBusy || controlsDisabled}
                          onClick={() => void onStopSkill(skill.name)}
                          tone="secondary"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          {text.skillPanel.stop}
                        </ActionButton>
                      ) : null}

                      {state.canSetDefault ? (
                        <ActionButton
                          disabled={isBusy || controlsDisabled}
                          onClick={() => void onSetDefaultSkill(skill.name)}
                          tone="ghost"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          {text.skillPanel.setDefault}
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
          ? "border-success/30 bg-success/10 text-success"
          : "border-amber-500/30 bg-amber-500/10 text-amber-500",
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
        input.tone === "primary" && "border-border bg-ink text-ink hover:bg-surface",
        input.tone === "secondary" && "border-border bg-paper text-ink hover:bg-surface",
        input.tone === "ghost" && "border-amber-500/30 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20",
      )}
    >
      {input.children}
    </button>
  )
}
