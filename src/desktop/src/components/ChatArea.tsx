import React, { useEffect, useRef, useState } from "react"
import {
  ArrowUp,
  Info,
  Loader2,
  MessageSquare,
  PanelLeft,
  Play,
  Square,
} from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import type {
  DesktopPermissionRequest,
  DesktopSession,
  DesktopSessionSnapshot,
  DesktopTranscriptMessage,
} from "../view-types"
import { cn } from "../lib/utils"
import { Message } from "./Message"
import { PermissionRequest } from "./PermissionRequest"

interface ChatAreaProps {
  sessionSummary: DesktopSession | null
  session: DesktopSessionSnapshot | null
  transcript: DesktopTranscriptMessage[]
  permissionRequests: DesktopPermissionRequest[]
  onSendMessage: (msg: string) => void | Promise<unknown>
  onCancelRun: () => void | Promise<unknown>
  onReplyPermission: (id: string, decision: "allow" | "deny") => void | Promise<unknown>
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  errorMessage: string | null
}

export function ChatArea({
  sessionSummary,
  session,
  transcript,
  permissionRequests,
  onSendMessage,
  onCancelRun,
  onReplyPermission,
  isSidebarOpen,
  onToggleSidebar,
  errorMessage,
}: ChatAreaProps) {
  const [input, setInput] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const isRunning = session?.activeRun?.status === "running"
  const isWaiting = session?.activeRun?.status === "waiting_permission"
  const isBusy = isRunning || isWaiting

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [transcript, permissionRequests, session?.activeRun?.status])

  const submitMessage = () => {
    if (!input.trim() || isBusy) {
      return
    }

    void onSendMessage(input)
    setInput("")
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    submitMessage()
  }

  if (!sessionSummary) {
    return (
      <div className="relative flex flex-1 flex-col bg-white">
        <div className="absolute top-4 left-4 z-10">
          {!isSidebarOpen ? (
            <button
              onClick={onToggleSidebar}
              className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              title="Open Sidebar"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-zinc-400">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-zinc-100 bg-zinc-50 shadow-sm">
            <Play className="ml-1 h-6 w-6 text-zinc-300" />
          </div>
          <p className="text-sm font-medium tracking-wide text-zinc-500">Select a session to start</p>
          {errorMessage ? <p className="mt-3 max-w-sm text-center text-xs text-rose-500">{errorMessage}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-1 flex-col bg-white">
      <div className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-zinc-200 bg-white/80 px-4 backdrop-blur-md md:px-6">
        <div className="flex items-center gap-3">
          {!isSidebarOpen ? (
            <button
              onClick={onToggleSidebar}
              className="-ml-1.5 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              title="Open Sidebar"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          ) : null}
          <h2 className="font-semibold tracking-tight text-zinc-800">
            {sessionSummary.title || "Untitled Session"}
          </h2>

          <AnimatePresence mode="wait">
            {isRunning ? (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="flex items-center gap-1.5 rounded-full border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Agent Running
              </motion.div>
            ) : null}
            {isWaiting ? (
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600"
              >
                <Info className="h-3 w-3" />
                Waiting Permission
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-32 scroll-smooth md:px-8">
        {transcript.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center space-y-4 text-zinc-400">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-100 bg-zinc-50 shadow-sm">
              <MessageSquare className="h-5 w-5 text-zinc-300" />
            </div>
            <p className="text-sm text-zinc-500">Start a conversation with NeoCoworker</p>
            {errorMessage ? <p className="max-w-md text-center text-xs text-rose-500">{errorMessage}</p> : null}
          </div>
        ) : (
          <div className="mx-auto max-w-4xl py-8">
            {errorMessage ? (
              <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                {errorMessage}
              </div>
            ) : null}
            {transcript.map((message) => (
              <Message key={message.id} message={message} />
            ))}

            {permissionRequests.map((request) => (
              <PermissionRequest key={request.id} request={request} onReply={onReplyPermission} />
            ))}

            {isRunning ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 p-6 text-zinc-400"
              >
                <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                <span className="animate-pulse text-sm font-medium text-zinc-500">
                  NeoCoworker is thinking...
                </span>
              </motion.div>
            ) : null}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-white via-white/80 to-transparent p-4">
        <div className="relative mx-auto max-w-4xl">
          <form
            onSubmit={handleSubmit}
            className={cn(
              "relative flex items-end gap-2 overflow-hidden rounded-2xl border bg-white shadow-sm transition-all",
              isBusy
                ? "border-zinc-200 opacity-80"
                : "border-zinc-300 focus-within:border-indigo-500/50 focus-within:ring-4 focus-within:ring-indigo-500/10",
            )}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={isBusy ? "Agent is busy..." : "Ask NeoCoworker to do something..."}
              disabled={isBusy}
              className="min-h-[56px] max-h-64 flex-1 resize-none border-0 bg-transparent py-4 pr-14 pl-4 text-[15px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 outline-none focus:ring-0"
              rows={1}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  submitMessage()
                }
              }}
            />

            <div className="absolute right-2 bottom-2 flex items-center gap-2">
              {isBusy ? (
                <button
                  type="button"
                  onClick={() => void onCancelRun()}
                  className="rounded-xl border border-rose-100 bg-rose-50 p-2 text-rose-600 transition-colors hover:bg-rose-100"
                  title="Cancel Run"
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="rounded-xl bg-zinc-900 p-2 text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:opacity-50 disabled:hover:bg-zinc-900"
                >
                  <ArrowUp className="h-5 w-5" />
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
