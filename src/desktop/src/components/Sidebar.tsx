import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import {
  AlertCircle,
  Folder,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Settings2,
  ShieldAlert,
} from "lucide-react"
import type { DesktopServerMode, DesktopSettings } from "../desktop-settings"
import { cn } from "../lib/utils"
import { useDesktopText } from "../i18n"
import type { DesktopSettingsSuccessMessage } from "../useDesktopSettings"
import type { DesktopSession, DesktopWorkspace } from "../view-types"
import { isBusyRunStatus, shouldBlockSettingsApplyFromBusyState } from "../busy-state"
import { SettingsPanel } from "./SettingsPanel"
import { hasVisibleWorkspaceSelect } from "./sidebar-workspace-state"

type DateGroup = { label: string; sessions: DesktopSession[] }

function groupSessionsByDate(
  sessions: DesktopSession[],
  text: ReturnType<typeof useDesktopText>,
): DateGroup[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86_400_000)

  const groups: DateGroup[] = []
  const todaySessions: DesktopSession[] = []
  const yesterdaySessions: DesktopSession[] = []
  const earlierSessions: DesktopSession[] = []

  for (const session of sessions) {
    const created = new Date(session.createdAt)
    if (created >= today) todaySessions.push(session)
    else if (created >= yesterday) yesterdaySessions.push(session)
    else earlierSessions.push(session)
  }

  if (todaySessions.length > 0)
    groups.push({ label: text.sidebar.today, sessions: todaySessions })
  if (yesterdaySessions.length > 0)
    groups.push({ label: text.sidebar.yesterday, sessions: yesterdaySessions })
  if (earlierSessions.length > 0)
    groups.push({ label: text.sidebar.earlier, sessions: earlierSessions })

  return groups
}

interface SidebarProps {
  workspaces: DesktopWorkspace[]
  activeWorkspaceRoot: string | null
  setActiveWorkspace: (ws: string) => void
  sessions: DesktopSession[]
  activeSessionId: string | null
  setActiveSessionId: (id: string) => void
  createSession: () => void
  createWorkspace: () => Promise<boolean>
  deleteSession: (sessionId: string) => void | Promise<unknown>
  settings: DesktopSettings
  serverMode: DesktopServerMode
  settingsErrorMessage: string | null
  settingsSuccessMessage: DesktopSettingsSuccessMessage | null
  isApplyingSettings: boolean
  onUpdateSettings: (patch: Partial<DesktopSettings>) => void | Promise<unknown>
  onApplyGeneralSettings: () => void | Promise<unknown>
  onApplyLlmSettings: () => void | Promise<unknown>
  isManagingWorkspace: boolean
  isOnline: boolean
  hasAuthoritativeBusyState: boolean
  isOpen: boolean
  onToggle: () => void
}

export function Sidebar({
  workspaces,
  activeWorkspaceRoot,
  setActiveWorkspace,
  sessions,
  activeSessionId,
  setActiveSessionId,
  createSession,
  createWorkspace,
  deleteSession,
  settings,
  serverMode,
  settingsErrorMessage,
  settingsSuccessMessage,
  isApplyingSettings,
  onUpdateSettings,
  onApplyGeneralSettings,
  onApplyLlmSettings,
  isManagingWorkspace,
  isOnline,
  hasAuthoritativeBusyState,
  isOpen,
  onToggle,
}: SidebarProps) {
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string
    x: number
    y: number
  } | null>(null)
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null)
  const sessionContextMenuRef = useRef<HTMLDivElement | null>(null)
  const settingsPanelRef = useRef<HTMLDivElement | null>(null)
  const showWorkspaceSelect = hasVisibleWorkspaceSelect(workspaces.length)
  const activeWorkspace =
    workspaces.find((workspace) => workspace.workspaceRoot === activeWorkspaceRoot) ??
    workspaces[0] ??
    null
  const contextMenuSession =
    sessions.find((session) => session.id === sessionContextMenu?.sessionId) ?? null
  const hasBusySession = shouldBlockSettingsApplyFromBusyState({
    hasAuthoritativeBusyState,
    sessions,
    workspaces,
  })
  const text = useDesktopText()
  const sessionGroups = groupSessionsByDate(sessions, text)

  useEffect(() => {
    if (!isWorkspaceMenuOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) {
        setIsWorkspaceMenuOpen(false)
      }
    }

    window.addEventListener("mousedown", handlePointerDown)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
    }
  }, [isWorkspaceMenuOpen])

  useEffect(() => {
    if (!sessionContextMenu) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!sessionContextMenuRef.current?.contains(event.target as Node)) {
        setSessionContextMenu(null)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSessionContextMenu(null)
      }
    }

    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [sessionContextMenu])

  useEffect(() => {
    if (!isSettingsOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!settingsPanelRef.current?.contains(event.target as Node)) {
        setIsSettingsOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSettingsOpen(false)
      }
    }

    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isSettingsOpen])

  return (
    <div
      className={cn(
        "h-full shrink-0 transition-all duration-300 ease-in-out",
        isSettingsOpen ? "overflow-visible" : "overflow-hidden",
        isOpen ? "w-64" : "w-0",
      )}
    >
      <div className="flex h-full w-64 flex-col border-r border-border bg-paper font-sans text-muted">
        <div className="flex h-14 items-center justify-between border-b border-border bg-paper px-4 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-ink shadow-sm">
              <div className="flex items-center -space-x-[1px]">
                <span className="text-xs font-bold">N</span>
                <span className="text-xs font-light text-accent">C</span>
              </div>
            </div>
            <span className="font-semibold tracking-tight text-ink">NeoCoworker</span>
          </div>
          <button
            onClick={onToggle}
            className="rounded-md p-1.5 text-accent transition-colors hover:bg-border hover:text-ink"
            title="Close Sidebar"
          >
            <PanelLeftClose className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
          <section className="pb-4">
            <div className="mb-3 flex items-center justify-between px-1">
              <label className="text-[11px] font-semibold tracking-[0.16em] text-accent uppercase">
                {text.sidebar.workspace}
              </label>
              <div
                className={cn(
                  "h-2 w-2 rounded-full transition-colors",
                  isOnline ? "bg-success" : "bg-border",
                )}
              />
            </div>

            <div
              className={cn(
                "grid transition-all duration-300 ease-out",
                showWorkspaceSelect ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className={cn(showWorkspaceSelect ? "overflow-visible" : "overflow-hidden")}>
                <div
                  className={cn(
                    "relative z-10 transition-all duration-300 ease-out",
                    showWorkspaceSelect ? "translate-y-0" : "-translate-y-1.5",
                  )}
                  ref={workspaceMenuRef}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex h-10 w-full items-center rounded-xl border border-border bg-paper px-3 pl-9 pr-8 text-left text-sm text-ink shadow-sm outline-none transition-colors focus:border-border focus:ring-2 focus:ring-border",
                      showWorkspaceSelect && !isManagingWorkspace && "cursor-pointer hover:bg-paper",
                      isWorkspaceMenuOpen && "border-border ring-2 ring-border",
                      (!showWorkspaceSelect || isManagingWorkspace) && "cursor-not-allowed opacity-60",
                    )}
                    disabled={!showWorkspaceSelect || isManagingWorkspace}
                    aria-haspopup="listbox"
                    aria-expanded={isWorkspaceMenuOpen}
                    onClick={() => setIsWorkspaceMenuOpen((previous) => !previous)}
                  >
                    <span className="truncate">{activeWorkspace?.name ?? "Select workspace"}</span>
                  </button>
                  <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
                    <Folder className="h-4 w-4 text-accent" />
                  </div>
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-3 flex items-center text-accent transition-transform",
                      isWorkspaceMenuOpen && "rotate-180",
                    )}
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div
                    className={cn(
                      "absolute top-[calc(100%+0.5rem)] left-0 right-0 z-20 origin-top overflow-hidden rounded-xl border border-border bg-paper shadow-xl backdrop-blur-sm transition-all duration-200",
                      isWorkspaceMenuOpen
                        ? "pointer-events-auto translate-y-0 opacity-100"
                        : "pointer-events-none -translate-y-1 opacity-0",
                    )}
                  >
                    <div className="max-h-56 overflow-y-auto p-1.5">
                      {workspaces.map((workspace) => (
                        <button
                          key={workspace.id}
                          type="button"
                          role="option"
                          aria-selected={workspace.workspaceRoot === activeWorkspaceRoot}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                            workspace.workspaceRoot === activeWorkspaceRoot
                              ? "bg-surface text-ink shadow-sm ring-1 ring-border"
                              : "text-ink hover:bg-surface",
                          )}
                          onClick={() => {
                            setIsWorkspaceMenuOpen(false)
                            setActiveWorkspace(workspace.workspaceRoot)
                          }}
                        >
                          <Folder
                            className={cn(
                              "h-4 w-4 shrink-0",
                              workspace.workspaceRoot === activeWorkspaceRoot
                                ? "text-muted"
                                : "text-accent",
                            )}
                          />
                          <span className="truncate">{workspace.name}</span>
                        </button>
                      ))}
                      <div className="my-1 border-t border-border" />
                      <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={isManagingWorkspace}
                        onClick={() => {
                          setIsWorkspaceMenuOpen(false)
                          void createWorkspace()
                        }}
                      >
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-paper text-muted shadow-sm">
                          <Plus className="h-3.5 w-3.5" />
                        </div>
                        <span className="truncate font-medium text-ink">{text.sidebar.newWorkspace}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <div className="mx-1 border-t border-border" />

          <section className="flex min-h-0 flex-1 flex-col pt-4">
            <div className="mb-3 flex items-center justify-between px-1">
              <label className="text-[11px] font-semibold tracking-[0.16em] text-accent uppercase">
                {text.sidebar.sessions}
              </label>
              <button
                onClick={() => createSession()}
                disabled={!showWorkspaceSelect}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-paper px-2 text-[11px] font-medium text-muted transition-colors hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                title="New Session"
              >
                <Plus className="h-3.5 w-3.5" />
                {text.sidebar.newSession}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              {sessionGroups.length > 0 ? (
                <div className="space-y-3">
                  {sessionGroups.map((group) => (
                    <div key={group.label}>
                      <div className="mb-1.5 px-1 text-[10px] font-medium tracking-widest text-accent/60 uppercase">
                        {group.label}
                      </div>
                      <div className="space-y-1">
                        {group.sessions.map((session) => (
                          <SessionListItem
                            key={session.id}
                            session={session}
                            isActive={activeSessionId === session.id}
                            onSelect={() => setActiveSessionId(session.id)}
                            onOpenContextMenu={(event) => {
                              event.preventDefault()
                              setSessionContextMenu({
                                sessionId: session.id,
                                x: event.clientX,
                                y: event.clientY,
                              })
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-paper px-3 py-4 text-xs italic text-muted">
                  {text.sidebar.noSessions}
                </div>
              )}
            </div>
          </section>

          <div ref={settingsPanelRef} className="relative mt-3">
            <SettingsPanel
              isOpen={isSettingsOpen}
              settings={settings}
              serverMode={serverMode}
              isApplying={isApplyingSettings}
              hasBusySession={hasBusySession}
              errorMessage={settingsErrorMessage}
              successMessage={settingsSuccessMessage}
              onClose={() => setIsSettingsOpen(false)}
              onUpdateSettings={onUpdateSettings}
              onApplyGeneralSettings={onApplyGeneralSettings}
              onApplyLlmSettings={onApplyLlmSettings}
            />

            <div className="flex items-end justify-between px-1 pt-2">
              <button
                type="button"
                onClick={() => setIsSettingsOpen((previous) => !previous)}
                aria-label={text.sidebar.settings}
                aria-expanded={isSettingsOpen}
                className={cn(
                  "group flex h-10 w-10 items-center justify-center rounded-full border border-border bg-paper text-muted shadow-sm transition-all hover:-translate-y-0.5 hover:bg-paper hover:text-ink",
                  isSettingsOpen && "border-border bg-paper text-ink shadow-lg",
                )}
              >
                <Settings2 className={cn("h-4.5 w-4.5 transition-transform", isSettingsOpen && "rotate-45")} />
              </button>

              <div className="flex flex-col items-end text-[11px] tracking-[0.08em] text-accent uppercase">
                <span>{text.sidebar.desktop}</span>
                <span className="mt-1">{isOnline ? text.sidebar.online : text.sidebar.offline}</span>
              </div>
            </div>
          </div>
        </div>

        {sessionContextMenu && contextMenuSession ? (
          <div
            ref={sessionContextMenuRef}
            className="fixed z-50 w-56 rounded-xl border border-border bg-paper p-2 text-sm text-ink shadow-2xl backdrop-blur-sm"
            style={getContextMenuStyle(sessionContextMenu)}
          >
            <button
              type="button"
              disabled={isBusyRunStatus(contextMenuSession.latestRunStatus)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-medium text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:text-accent disabled:hover:bg-transparent"
              onClick={() => {
                setSessionContextMenu(null)
                if (!isBusyRunStatus(contextMenuSession.latestRunStatus)) {
                  void deleteSession(contextMenuSession.id)
                }
              }}
            >
              <span>{text.sidebar.deleteSession}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SessionListItem(input: {
  session: DesktopSession
  isActive: boolean
  onSelect(): void
  onOpenContextMenu(event: ReactMouseEvent<HTMLButtonElement>): void
}) {
  const text = useDesktopText()
  const badge = getSessionStatusBadge(input.session.latestRunStatus, text)

  return (
    <button
      onClick={input.onSelect}
      onContextMenu={input.onOpenContextMenu}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-all",
        input.isActive
          ? "border-border bg-paper font-medium text-ink shadow-sm"
          : "border-transparent text-muted hover:border-border hover:bg-paper hover:text-ink",
      )}
    >
      <MessageSquare
        className={cn(
          "h-4 w-4 shrink-0",
          input.isActive ? "text-ink" : "text-accent",
        )}
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{input.session.title || "Untitled Session"}</span>
        {badge ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
              badge.className,
            )}
          >
            <badge.icon className={cn("h-3 w-3", badge.iconClassName)} />
            {badge.label}
          </span>
        ) : null}
      </div>
    </button>
  )
}

function getSessionStatusBadge(
  status: DesktopSession["latestRunStatus"],
  text: ReturnType<typeof useDesktopText>,
) {
  if (status === "running") {
    return {
      label: text.sidebar.running,
      className: "border-highlight/30 bg-highlight/10 text-highlight",
      icon: Loader2,
      iconClassName: "animate-spin",
    }
  }

  if (status === "waiting_permission") {
    return {
      label: text.sidebar.waiting,
      className: "border-amber-500/30 bg-amber-500/10 text-amber-500",
      icon: ShieldAlert,
      iconClassName: "",
    }
  }

  if (status === "failed") {
    return {
      label: text.sidebar.failed,
      className: "border-danger bg-danger/10 text-danger",
      icon: AlertCircle,
      iconClassName: "",
    }
  }

  return null
}

function getContextMenuStyle(position: { x: number; y: number }) {
  if (typeof window === "undefined") {
    return {
      left: position.x,
      top: position.y,
    }
  }

  return {
    left: Math.min(position.x, window.innerWidth - 244),
    top: Math.min(position.y, window.innerHeight - 132),
  }
}
