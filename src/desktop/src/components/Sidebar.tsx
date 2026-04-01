import { useEffect, useRef, useState } from "react"
import { AlertCircle, Folder, Loader2, PanelLeftClose, Plus, MessageSquare, ShieldAlert } from "lucide-react"
import { cn } from "../lib/utils"
import type { DesktopSession, DesktopWorkspace } from "../view-types"
import { hasVisibleWorkspaceSelect } from "./sidebar-workspace-state"

interface SidebarProps {
  workspaces: DesktopWorkspace[]
  activeWorkspaceRoot: string | null
  setActiveWorkspace: (ws: string) => void
  sessions: DesktopSession[]
  activeSessionId: string | null
  setActiveSessionId: (id: string) => void
  createSession: () => void
  createWorkspace: () => Promise<boolean>
  isManagingWorkspace: boolean
  isOnline: boolean
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
  isManagingWorkspace,
  isOnline,
  isOpen,
  onToggle,
}: SidebarProps) {
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false)
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null)
  const showWorkspaceSelect = hasVisibleWorkspaceSelect(workspaces.length)
  const activeWorkspace =
    workspaces.find((workspace) => workspace.workspaceRoot === activeWorkspaceRoot) ??
    workspaces[0] ??
    null

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

  return (
    <div
      className={cn(
        "h-full shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
        isOpen ? "w-64" : "w-0",
      )}
    >
      <div className="flex h-full w-64 flex-col border-r border-zinc-200 bg-[linear-gradient(180deg,_#fafafa_0%,_#f5f5f4_100%)] font-sans text-zinc-600">
        <div className="flex h-14 items-center justify-between border-b border-zinc-200/80 bg-white/70 px-4 backdrop-blur-sm">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700/50 bg-gradient-to-br from-zinc-800 to-zinc-950 text-white shadow-sm">
              <div className="flex items-center -space-x-[1px]">
                <span className="text-xs font-bold">N</span>
                <span className="text-xs font-light text-zinc-400">C</span>
              </div>
            </div>
            <span className="font-semibold tracking-tight text-zinc-900">NeoCoworker</span>
          </div>
          <button
            onClick={onToggle}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/50 hover:text-zinc-700"
            title="Close Sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
          <section className="pb-4">
            <div className="mb-3 flex items-center justify-between px-1">
              <label className="text-[11px] font-semibold tracking-[0.16em] text-zinc-400 uppercase">
                Workspace
              </label>
              <div
                className={cn(
                  "h-2 w-2 rounded-full transition-colors",
                  isOnline ? "bg-emerald-500/70" : "bg-zinc-300",
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
                      "flex h-10 w-full items-center rounded-xl border border-zinc-200 bg-white/95 px-3 pl-9 pr-8 text-left text-sm text-zinc-700 shadow-sm outline-none transition-colors focus:border-zinc-300 focus:ring-2 focus:ring-zinc-200/80",
                      showWorkspaceSelect && !isManagingWorkspace && "cursor-pointer hover:bg-white",
                      isWorkspaceMenuOpen && "border-zinc-300 ring-2 ring-zinc-200/80",
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
                    <Folder className="h-4 w-4 text-zinc-400" />
                  </div>
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-400 transition-transform",
                      isWorkspaceMenuOpen && "rotate-180",
                    )}
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div
                    className={cn(
                      "absolute top-[calc(100%+0.5rem)] left-0 right-0 z-20 origin-top overflow-hidden rounded-xl border border-zinc-200 bg-white/98 shadow-[0_16px_40px_rgba(24,24,27,0.12)] backdrop-blur-sm transition-all duration-200",
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
                              ? "bg-zinc-100 text-zinc-900 shadow-sm ring-1 ring-zinc-200"
                              : "text-zinc-700 hover:bg-zinc-100",
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
                                ? "text-zinc-500"
                                : "text-zinc-400",
                            )}
                          />
                          <span className="truncate">{workspace.name}</span>
                        </button>
                      ))}
                      <div className="my-1 border-t border-zinc-200" />
                      <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={isManagingWorkspace}
                        onClick={() => {
                          setIsWorkspaceMenuOpen(false)
                          void createWorkspace()
                        }}
                      >
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm">
                          <Plus className="h-3.5 w-3.5" />
                        </div>
                        <span className="truncate font-medium text-zinc-800">New workspace</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <div className="mx-1 border-t border-zinc-200/80" />

          <section className="flex min-h-0 flex-1 flex-col pt-4">
            <div className="mb-3 flex items-center justify-between px-1">
              <label className="text-[11px] font-semibold tracking-[0.16em] text-zinc-400 uppercase">
                Sessions
              </label>
              <button
                onClick={() => createSession()}
                disabled={!showWorkspaceSelect}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white/80 px-2 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-white hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
                title="New Session"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              <div className="space-y-1">
                {sessions.map((session) => (
                  <SessionListItem
                    key={session.id}
                    session={session}
                    isActive={activeSessionId === session.id}
                    onSelect={() => setActiveSessionId(session.id)}
                  />
                ))}
                {sessions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-200 bg-white/60 px-3 py-4 text-xs italic text-zinc-500">
                    No sessions found.
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <div className="flex items-center justify-between px-1 text-[11px] tracking-[0.08em] text-zinc-400 uppercase">
            <span>Desktop</span>
            <span>{isOnline ? "Online" : "Offline"}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SessionListItem(input: {
  session: DesktopSession
  isActive: boolean
  onSelect(): void
}) {
  const badge = getSessionStatusBadge(input.session.latestRunStatus)

  return (
    <button
      onClick={input.onSelect}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-all",
        input.isActive
          ? "border-zinc-200 bg-white font-medium text-zinc-900 shadow-sm"
          : "border-transparent text-zinc-600 hover:border-zinc-200/80 hover:bg-white/80 hover:text-zinc-900",
      )}
    >
      <MessageSquare
        className={cn(
          "h-4 w-4 shrink-0",
          input.isActive ? "text-zinc-900" : "text-zinc-400",
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
            <badge.icon className="h-3 w-3" />
            {badge.label}
          </span>
        ) : null}
      </div>
    </button>
  )
}

function getSessionStatusBadge(status: DesktopSession["latestRunStatus"]) {
  if (status === "running") {
    return {
      label: "Running",
      className: "border-sky-200 bg-sky-50 text-sky-700",
      icon: Loader2,
    }
  }

  if (status === "waiting_permission") {
    return {
      label: "Waiting",
      className: "border-amber-200 bg-amber-50 text-amber-700",
      icon: ShieldAlert,
    }
  }

  if (status === "failed") {
    return {
      label: "Failed",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      icon: AlertCircle,
    }
  }

  return null
}
