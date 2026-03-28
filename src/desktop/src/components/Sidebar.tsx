import { Folder, PanelLeftClose, Plus, MessageSquare } from "lucide-react"
import { cn } from "../lib/utils"
import type { DesktopProject, DesktopThread } from "../view-types"

interface SidebarProps {
  projects: DesktopProject[]
  activeWorkspace: string | null
  setActiveWorkspace: (ws: string) => void
  threads: DesktopThread[]
  activeThreadId: string | null
  setActiveThreadId: (id: string) => void
  createThread: () => void
  isOnline: boolean
  isOpen: boolean
  onToggle: () => void
}

export function Sidebar({
  projects,
  activeWorkspace,
  setActiveWorkspace,
  threads,
  activeThreadId,
  setActiveThreadId,
  createThread,
  isOnline,
  isOpen,
  onToggle,
}: SidebarProps) {
  return (
    <div
      className={cn(
        "h-full shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
        isOpen ? "w-64" : "w-0",
      )}
    >
      <div className="flex h-full w-64 flex-col border-r border-zinc-200 bg-zinc-50 font-sans text-zinc-600">
        <div className="flex items-center justify-between border-b border-zinc-200 p-4">
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

        <div className="border-b border-zinc-200 p-3">
          <label className="mb-2 block px-1 text-xs font-semibold tracking-wider text-zinc-400 uppercase">
            Workspace
          </label>
          <div className="relative">
            <select
              className="w-full cursor-pointer appearance-none rounded-md border border-zinc-200 bg-white py-1.5 pl-8 pr-3 text-sm text-zinc-700 shadow-sm focus:ring-1 focus:ring-zinc-400 focus:outline-none"
              value={activeWorkspace || ""}
              onChange={(event) => setActiveWorkspace(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.workspaceRoot}>
                  {project.name}
                </option>
              ))}
            </select>
            <Folder className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-zinc-400" />
            <div className="pointer-events-none absolute top-2.5 right-2.5 text-zinc-400">
              <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <label className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">Sessions</label>
            <button
              onClick={() => createThread()}
              className="text-zinc-400 transition-colors hover:text-zinc-700"
              title="New Session"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-0.5">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => setActiveThreadId(thread.id)}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
                  activeThreadId === thread.id
                    ? "border-zinc-200/60 bg-white font-medium text-zinc-900 shadow-sm"
                    : "border-transparent text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900",
                )}
              >
                <MessageSquare
                  className={cn(
                    "h-4 w-4 shrink-0",
                    activeThreadId === thread.id ? "text-zinc-900" : "text-zinc-400",
                  )}
                />
                <span className="flex-1 truncate">{thread.title || "Untitled Session"}</span>
              </button>
            ))}
            {threads.length === 0 ? (
              <div className="px-1 py-2 text-xs italic text-zinc-500">No sessions found.</div>
            ) : null}
          </div>
        </div>

        <div className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-400">
          Status: {isOnline ? "online" : "offline"}
        </div>
      </div>
    </div>
  )
}
