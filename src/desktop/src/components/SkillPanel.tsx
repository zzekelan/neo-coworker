import { Check, Loader2, Plus, X } from "lucide-react"
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
  pendingSkills: string[]
  onStartSkill: (skillName: string) => void | Promise<unknown>
  onCancelPendingSkill: (skillName: string) => void | Promise<unknown>
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
  pendingSkills,
  onStartSkill,
  onCancelPendingSkill,
}: SkillPanelProps) {
  const text = useDesktopText()
  const filteredSkills = filterSkillCatalog(skills, query)

  return (
    <div className="mb-3 overflow-hidden rounded-[1.1rem] border border-border bg-paper shadow-[0_12px_36px_rgba(18,17,14,0.08)]">
      <div className="border-b border-border bg-paper px-3 py-2">
        <div className="min-w-0 text-[13px] font-medium text-ink">
          <p>{text.skillPanel.title}</p>
          <p className="truncate text-[11px] font-normal text-muted">
            {text.skillPanel.subtitle}
          </p>
        </div>
      </div>

      {warningMessage ? (
        <div className="border-b border-highlight/30 bg-highlight/10 px-3 py-1.5 text-[12px] text-highlight">
          {warningMessage}
        </div>
      ) : null}

      {controlsDisabled ? (
        <div className="border-b border-highlight/30 bg-highlight/10 px-3 py-1.5 text-[12px] text-highlight">
          {text.skillPanel.locked}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="border-b border-danger bg-danger/10 px-3 py-1.5 text-[12px] text-danger">{errorMessage}</div>
      ) : null}

      <div className="max-h-48 overflow-y-auto p-1">
        {filteredSkills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-paper px-3 py-4 text-[12px] text-muted">
            {skills.length === 0
              ? text.skillPanel.noWorkspaceSkills
              : text.skillPanel.noFilteredSkills}
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {filteredSkills.map((skill) => {
              const state = getSkillActionState({
                skillName: skill.name,
                session,
                activeRun,
              })
              const isBusy = busySkillName === skill.name
              const isPending = pendingSkills.includes(skill.name)
              const canCancel = state.isActive && isPending && !controlsDisabled
              const canStart = !state.isActive && !controlsDisabled
              const interactive = canCancel || canStart

              const handleClick = () => {
                if (isBusy) return
                if (canCancel) {
                  void onCancelPendingSkill(skill.name)
                } else if (canStart) {
                  void onStartSkill(skill.name)
                }
              }

              const title = canCancel
                ? text.skillPanel.cancelPending
                : canStart
                  ? text.skillPanel.start
                  : undefined

              return (
                <li key={skill.path}>
                  <button
                    type="button"
                    disabled={!interactive || isBusy}
                    onClick={handleClick}
                    title={title}
                    className={cn(
                      "group flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors",
                      interactive
                        ? "hover:bg-surface/60 focus-visible:bg-surface/60"
                        : "cursor-default",
                      state.isActive && !canCancel ? "bg-surface/30" : "",
                      "disabled:cursor-not-allowed",
                    )}
                  >
                    <span
                      className={cn(
                        "truncate font-mono text-[12px] tracking-tight",
                        state.isActive ? "text-muted" : "text-ink",
                      )}
                    >
                      {skill.name}
                    </span>

                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                      {isBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : canCancel ? (
                        <>
                          <Check className="h-3 w-3 group-hover:hidden group-focus-visible:hidden" />
                          <X className="hidden h-3 w-3 text-danger group-hover:block group-focus-visible:block" />
                        </>
                      ) : state.isActive ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Plus className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
