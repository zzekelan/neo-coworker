import React, { useEffect, useRef, useState } from "react"
import {
  ArrowUp,
  ChevronDown,
  Info,
  Loader2,
  MessageSquare,
  PanelLeft,
  Play,
  Plus,
  Sparkles,
  Square,
} from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import type {
  DesktopPermissionRequest,
  DesktopSession,
  DesktopSessionSnapshot,
  DesktopSkillCatalogEntry,
  DesktopTranscriptMessage,
} from "../view-types"
import { cn } from "../lib/utils"
import { createSkillUpdateQueue, type SkillUpdateQueue } from "../skill-update-queue"
import { isBusyRunStatus } from "../busy-state"
import { Message } from "./Message"
import { PermissionRequest } from "./PermissionRequest"
import { SkillPanel } from "./SkillPanel"
import { getEffectiveActiveSkills, toggleSkill } from "./skill-state"
import { useDesktopText } from "../i18n"

const SKILL_DRAWER_TRANSITION = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
}

interface ChatAreaProps {
  sessionSummary: DesktopSession | null
  hasSessions: boolean
  session: DesktopSessionSnapshot | null
  skills: DesktopSkillCatalogEntry[]
  transcript: DesktopTranscriptMessage[]
  permissionRequests: DesktopPermissionRequest[]
  onSendMessage: (msg: string) => void | Promise<unknown>
  onCancelRun: () => void | Promise<unknown>
  onReplyPermission: (id: string, decision: "allow" | "deny") => boolean | Promise<boolean>
  onSetSessionActiveSkills: (sessionId: string, activeSkills: string[]) => void | Promise<unknown>
  onCreateSession: () => void | Promise<unknown>
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  errorMessage: string | null
  skillWarningMessage: string | null
}

export function ChatArea({
  sessionSummary,
  hasSessions,
  session,
  skills,
  transcript,
  permissionRequests,
  onSendMessage,
  onCancelRun,
  onReplyPermission,
  onSetSessionActiveSkills,
  onCreateSession,
  isSidebarOpen,
  onToggleSidebar,
  errorMessage,
  skillWarningMessage,
}: ChatAreaProps) {
  const text = useDesktopText()
  const [input, setInput] = useState("")
  const [isSubmittingMessage, setIsSubmittingMessage] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [isSkillPanelOpen, setIsSkillPanelOpen] = useState(false)
  const [skillFilter, setSkillFilter] = useState("")
  const [busySkillName, setBusySkillName] = useState<string | null>(null)
  const [skillErrorMessage, setSkillErrorMessage] = useState<string | null>(null)
  const [optimisticSessionSkills, setOptimisticSessionSkills] = useState<string[] | null>(null)
  const transcriptViewportRef = useRef<HTMLDivElement>(null)
  const skillPanelShellRef = useRef<HTMLDivElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const sessionSkillQueueRef = useRef<{
    sessionId: string | null
    queue: SkillUpdateQueue | null
  }>({
    sessionId: null,
    queue: null,
  })
  const activeRunStatus = session?.activeRun?.status ?? null
  const isRunning = activeRunStatus === "running"
  const isWaiting = activeRunStatus === "waiting_permission"
  const isBusy = isBusyRunStatus(activeRunStatus)
  const isRunSkillEditingLocked = Boolean(session?.activeRun)
  const sessionSummaryWithOptimisticSkills =
    sessionSummary && optimisticSessionSkills
      ? {
          ...sessionSummary,
          activeSkills: optimisticSessionSkills,
        }
      : sessionSummary
  const visibleActiveSkills = getEffectiveActiveSkills({
    session: sessionSummaryWithOptimisticSkills,
    activeRun: session?.activeRun,
  })

  useEffect(() => {
    sessionSkillQueueRef.current.queue?.reset()
    sessionSkillQueueRef.current = {
      sessionId: sessionSummary?.id ?? null,
      queue: null,
    }
    setOptimisticSessionSkills(null)
    setSkillErrorMessage(null)
    setBusySkillName(null)
  }, [sessionSummary?.id, session?.activeRun?.id])

  useEffect(() => {
    setIsSkillPanelOpen(false)
    setSkillFilter("")
  }, [sessionSummary?.id])

  useEffect(() => {
    shouldStickToBottomRef.current = true
  }, [sessionSummary?.id])

  useEffect(() => {
    if (!isSkillPanelOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!skillPanelShellRef.current?.contains(event.target as Node)) {
        setIsSkillPanelOpen(false)
      }
    }

    window.addEventListener("mousedown", handlePointerDown)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
    }
  }, [isSkillPanelOpen])

  useEffect(() => {
    const viewport = transcriptViewportRef.current

    if (!viewport || !shouldStickToBottomRef.current) {
      return
    }

    viewport.scrollTop = viewport.scrollHeight
  }, [transcript, permissionRequests, session?.activeRun?.status])

  const stickTranscriptToBottom = () => {
    shouldStickToBottomRef.current = true
    const viewport = transcriptViewportRef.current
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }

  const submitMessage = async () => {
    const nextInput = input
    if (!nextInput.trim() || isBusy || isComposing || isSubmittingMessage) {
      return
    }

    stickTranscriptToBottom()
    setIsSubmittingMessage(true)

    try {
      await sessionSkillQueueRef.current.queue?.flush()
      const sent = await onSendMessage(nextInput)
      if (sent === false) {
        return
      }

      setInput("")
    } catch {
      return
    } finally {
      setIsSubmittingMessage(false)
    }
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    void submitMessage()
  }

  const getSessionSkillQueue = (sessionId: string) => {
    if (
      sessionSkillQueueRef.current.sessionId === sessionId &&
      sessionSkillQueueRef.current.queue
    ) {
      return sessionSkillQueueRef.current.queue
    }

    const queue = createSkillUpdateQueue({
      async submit(skills) {
        await onSetSessionActiveSkills(sessionId, skills)
      },
      onOptimisticChange(skills) {
        setOptimisticSessionSkills(skills)
        if (skills === null) {
          setBusySkillName(null)
        }
      },
      onError(error) {
        setSkillErrorMessage(error instanceof Error ? error.message : String(error))
        setBusySkillName(null)
      },
    })

    sessionSkillQueueRef.current = {
      sessionId,
      queue,
    }
    return queue
  }

  const updateSkillSet = async (skillName: string, enabled: boolean) => {
    if (!sessionSummary || isRunSkillEditingLocked) {
      return
    }

    setBusySkillName(skillName)
    setSkillErrorMessage(null)

    const nextSkills = toggleSkill({
      skills: sessionSummaryWithOptimisticSkills?.activeSkills ?? [],
      skillName,
      enabled,
    })
    getSessionSkillQueue(sessionSummary.id).enqueue(nextSkills)
  }

  const setDefaultSkill = async (skillName: string) => {
    if (!sessionSummary || isRunSkillEditingLocked) {
      return
    }

    setBusySkillName(skillName)
    setSkillErrorMessage(null)

    const nextSkills = toggleSkill({
      skills: sessionSummaryWithOptimisticSkills?.activeSkills ?? [],
      skillName,
      enabled: true,
    })
    getSessionSkillQueue(sessionSummary.id).enqueue(nextSkills)
  }

  const handlePermissionReply = (requestId: string, decision: "allow" | "deny") => {
    stickTranscriptToBottom()
    return onReplyPermission(requestId, decision)
  }

  const isInputLocked = isBusy || isSubmittingMessage

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
        <EmptyChatState
          icon={<Play className="h-6 w-6 text-zinc-300" />}
          title={hasSessions ? text.chat.selectSession : text.chat.createSessionToStart}
          action={
            !hasSessions ? (
              <button
                type="button"
                onClick={() => void onCreateSession()}
                className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              >
                <Plus className="h-4 w-4" />
                {text.chat.createSession}
              </button>
            ) : null
          }
          errorMessage={errorMessage}
        />
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
                {text.chat.agentRunning}
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
                {text.chat.waitingPermission}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div
        ref={transcriptViewportRef}
        onScroll={(event) => {
          shouldStickToBottomRef.current = isNearTranscriptBottom(event.currentTarget)
        }}
        className="flex-1 overflow-y-auto px-4 pb-32 md:px-8"
      >
        {transcript.length === 0 ? (
          <EmptyChatState
            icon={<MessageSquare className="h-6 w-6 text-zinc-300" />}
            title={text.chat.startConversation}
            errorMessage={errorMessage}
          />
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

            {permissionRequests.map((request, index) => (
              <PermissionRequest
                key={request.id}
                request={request}
                autoFocus={index === 0}
                onReply={handlePermissionReply}
              />
            ))}

            {isRunning ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 p-6 text-zinc-400"
              >
                <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                <span className="animate-pulse text-sm font-medium text-zinc-500">
                  {text.chat.thinking}
                </span>
              </motion.div>
            ) : null}
          </div>
        )}
      </div>

      <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-white via-white/80 to-transparent p-4">
        <motion.div layout transition={SKILL_DRAWER_TRANSITION} className="relative mx-auto max-w-4xl">
          <div ref={skillPanelShellRef}>
            <motion.div
              layout="position"
              transition={SKILL_DRAWER_TRANSITION}
              className="mb-3 flex flex-wrap items-center gap-2"
            >
              <button
                type="button"
                onClick={() => setIsSkillPanelOpen((previous) => !previous)}
                className={cn(
                  "inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors",
                  isSkillPanelOpen
                    ? "border-zinc-300 bg-zinc-100 text-zinc-900"
                    : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100",
                )}
              >
                <Sparkles className="h-4 w-4" />
                {text.chat.skills}
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", !isSkillPanelOpen && "rotate-180")}
                />
              </button>

              {visibleActiveSkills.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {visibleActiveSkills.map((skillName) => (
                    <span
                      key={skillName}
                      className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-600"
                    >
                      {skillName}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-zinc-400">{text.chat.noActiveSkills}</span>
              )}
            </motion.div>

            <AnimatePresence initial={false}>
              {isSkillPanelOpen ? (
                <motion.div
                  key="skill-panel-shell"
                  initial={{ height: 0, opacity: 0, y: 12 }}
                  animate={{ height: "auto", opacity: 1, y: 0 }}
                  exit={{ height: 0, opacity: 0, y: 12 }}
                  transition={SKILL_DRAWER_TRANSITION}
                  className="overflow-hidden"
                >
                  <motion.div layout transition={SKILL_DRAWER_TRANSITION}>
                    <SkillPanel
                      skills={skills}
                      query={skillFilter}
                      session={sessionSummaryWithOptimisticSkills}
                      activeRun={session?.activeRun}
                      controlsDisabled={isRunSkillEditingLocked}
                      busySkillName={busySkillName}
                      errorMessage={skillErrorMessage}
                      warningMessage={skillWarningMessage}
                      onStartSkill={(skillName) => updateSkillSet(skillName, true)}
                      onStopSkill={(skillName) => updateSkillSet(skillName, false)}
                      onSetDefaultSkill={setDefaultSkill}
                    />
                    <div className="mb-3">
                      <input
                        value={skillFilter}
                        onChange={(event) => setSkillFilter(event.target.value)}
                        placeholder={text.chat.filterSkills}
                        className="h-11 w-full rounded-2xl border border-zinc-200 bg-white px-4 text-sm text-zinc-800 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-300"
                      />
                    </div>
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <motion.form
            layout
            transition={SKILL_DRAWER_TRANSITION}
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
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              placeholder={
                isBusy
                  ? text.chat.agentBusyPlaceholder
                  : text.chat.askPlaceholder
              }
              disabled={isInputLocked}
              className="min-h-[56px] max-h-64 flex-1 resize-none border-0 bg-transparent py-4 pr-14 pl-4 text-[15px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 outline-none focus:ring-0"
              rows={1}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !isComposing &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  void submitMessage()
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
                  disabled={!input.trim() || isComposing || isSubmittingMessage}
                  className="rounded-xl bg-zinc-900 p-2 text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:opacity-50 disabled:hover:bg-zinc-900"
                >
                  <ArrowUp className="h-5 w-5" />
                </button>
              )}
            </div>
          </motion.form>
        </motion.div>
      </div>
    </div>
  )
}

function isNearTranscriptBottom(element: HTMLDivElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48
}

function EmptyChatState(input: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
  errorMessage: string | null
}) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex w-full max-w-md flex-col items-center justify-center px-6 text-center text-zinc-400">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-zinc-100 bg-zinc-50 shadow-sm">
          {input.icon}
        </div>
        <p className="text-sm font-medium tracking-wide text-zinc-500">{input.title}</p>
        {input.action}
        {input.errorMessage ? (
          <p className="mt-3 max-w-sm text-center text-xs text-rose-500">{input.errorMessage}</p>
        ) : null}
      </div>
    </div>
  )
}
