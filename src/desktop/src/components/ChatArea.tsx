import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowUp,
  ChevronDown,
  Loader2,
  MessageSquare,
  Moon,
  PanelLeft,
  Play,
  Plus,
  Sparkles,
  Square,
  Sun,
} from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import type {
  DesktopContextUsage,
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
import { CompactionDivider } from "./CompactionDivider"
import { PermissionRequest } from "./PermissionRequest"
import { SkillPanel } from "./SkillPanel"
import { getEffectiveActiveSkills, toggleSkill } from "./skill-state"
import { VirtualTranscript } from "./VirtualTranscript"
import { useDesktopText } from "../i18n"
import { useTheme } from "../providers/ThemeProvider"

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
  contextUsage: DesktopContextUsage | null
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
  contextUsage,
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
  const scrollToBottomRef = useRef<(() => void) | null>(null)

  const skillPanelShellRef = useRef<HTMLDivElement>(null)
  const sessionSkillQueueRef = useRef<{
    sessionId: string | null
    queue: SkillUpdateQueue | null
  }>({
    sessionId: null,
    queue: null,
  })
  const activeRunStatus = session?.activeRun?.status ?? null
  const isRunning = activeRunStatus === "running"
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
    if (!isSkillPanelOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!skillPanelShellRef.current?.contains(event.target as Node)) {
        setIsSkillPanelOpen(false)
      }
    }

    const handleCloseOverlays = () => {
      setIsSkillPanelOpen(false)
    }

    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("close-overlays", handleCloseOverlays)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("close-overlays", handleCloseOverlays)
    }
  }, [isSkillPanelOpen])

  const submitMessage = async () => {
    const nextInput = input
    if (!nextInput.trim() || isBusy || isComposing || isSubmittingMessage) {
      return
    }

    scrollToBottomRef.current?.()
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

  const getSessionSkillQueue = useCallback((sessionId: string) => {
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
  }, [onSetSessionActiveSkills])

  const updateSkillSet = useCallback(async (skillName: string, enabled: boolean) => {
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
  }, [sessionSummary, isRunSkillEditingLocked, sessionSummaryWithOptimisticSkills, getSessionSkillQueue])

  const setDefaultSkill = useCallback(async (skillName: string) => {
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
  }, [sessionSummary, isRunSkillEditingLocked, sessionSummaryWithOptimisticSkills, getSessionSkillQueue])

  const handlePermissionReply = useCallback((requestId: string, decision: "allow" | "deny") => {
    scrollToBottomRef.current?.()
    return onReplyPermission(requestId, decision)
  }, [onReplyPermission])

  const handleStartSkill = useCallback((skillName: string) => updateSkillSet(skillName, true), [updateSkillSet])
  const handleStopSkill = useCallback((skillName: string) => updateSkillSet(skillName, false), [updateSkillSet])

  const isInputLocked = isBusy || isSubmittingMessage

  if (!sessionSummary) {
    return (
      <div className="relative flex flex-1 flex-col bg-paper">
        <div className="absolute top-4 left-4 z-10">
          {!isSidebarOpen ? (
            <button
              onClick={onToggleSidebar}
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
              title="Open Sidebar"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          ) : null}
        </div>
        <EmptyChatState
          icon={<Play className="h-6 w-6 text-accent" />}
          title={hasSessions ? text.chat.selectSession : text.chat.createSessionToStart}
          action={
            !hasSessions ? (
              <button
                type="button"
                onClick={() => void onCreateSession()}
                className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-paper px-4 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-paper hover:text-ink"
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
    <div className="relative flex h-full flex-1 flex-col bg-paper">
      <div className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-paper px-4 backdrop-blur-md md:px-6">
        <div className="flex items-center gap-3">
          {!isSidebarOpen ? (
            <button
              onClick={onToggleSidebar}
              className="-ml-1.5 rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
              title="Open Sidebar"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          ) : null}
          <h2 className="font-semibold tracking-tight text-ink">
            {sessionSummary.title || "Untitled Session"}
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggleButton />
          {contextUsage ? (
            <ContextBudgetBar usage={contextUsage} />
          ) : null}
        </div>
      </div>

      {transcript.length === 0 ? (
        <div className="flex-1 overflow-y-auto px-4 pb-32 md:px-8">
          <EmptyChatState
            icon={<MessageSquare className="h-6 w-6 text-accent" />}
            title={text.chat.startConversation}
            errorMessage={errorMessage}
            offsetClassName="translate-y-2"
          />
        </div>
      ) : (
        <VirtualTranscript
          messages={transcript}
          scrollToBottomRef={scrollToBottomRef}
          estimatedItemHeight={100}
          overscan={5}
          className="px-4 pb-32 md:px-8"
          renderItem={(message) => {
            const boundaryPart = message.parts?.find((p) => p.type === "compaction_boundary")
            return (
              <div className="mx-auto max-w-4xl" style={{ paddingBottom: "1.5rem" }}>
                {boundaryPart && boundaryPart.type === "compaction_boundary" ? (
                  <CompactionDivider
                    tokensBefore={boundaryPart.tokensBefore}
                    tokensAfter={boundaryPart.tokensAfter}
                  />
                ) : (
                  <Message message={message} />
                )}
              </div>
            )
          }}
          footer={
            <div className="mx-auto max-w-4xl">
              {errorMessage ? (
                <div className="mb-4 rounded-xl border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
                  {errorMessage}
                </div>
              ) : null}

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
                  className="flex items-center gap-3 p-6 text-accent"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-highlight" />
                  <span className="animate-pulse text-sm font-medium text-muted">
                    {text.chat.thinking}
                  </span>
                </motion.div>
              ) : null}
            </div>
          }
        />
      )}

      <div className="absolute right-0 bottom-0 left-0 border-t border-border bg-paper/95 p-4 backdrop-blur-sm">
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
                    ? "border-border bg-surface text-ink"
                    : "border-border bg-paper text-ink hover:bg-surface",
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
                      className="rounded-full border border-border bg-surface px-2 py-1 text-[11px] font-medium text-muted"
                    >
                      {skillName}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-accent">{text.chat.noActiveSkills}</span>
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
                        onStartSkill={handleStartSkill}
                        onStopSkill={handleStopSkill}
                        onSetDefaultSkill={setDefaultSkill}
                      />
                    <div className="mb-3">
                      <input
                        value={skillFilter}
                        onChange={(event) => setSkillFilter(event.target.value)}
                        placeholder={text.chat.filterSkills}
                        className="h-11 w-full rounded-2xl border border-border bg-paper px-4 text-sm text-ink shadow-sm outline-none transition-colors placeholder:text-accent focus:border-border"
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
              "relative flex items-end gap-2 overflow-hidden rounded-2xl border bg-paper shadow-sm transition-all",
              isBusy
                ? "border-border opacity-80"
                : "border-border focus-within:border-highlight/50 focus-within:ring-4 focus-within:ring-highlight/10",
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
              className="min-h-[56px] max-h-64 flex-1 resize-none border-0 bg-transparent py-4 pr-14 pl-4 text-[15px] leading-relaxed text-ink placeholder:text-accent outline-none focus:ring-0"
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
                  className="rounded-xl border border-danger/30 bg-danger/10 p-2 text-danger transition-colors hover:bg-danger/20"
                  title="Cancel Run"
                >
                  <Square className="h-4 w-4 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() || isComposing || isSubmittingMessage}
                  className="rounded-xl bg-ink p-2 text-ink shadow-sm transition-colors hover:bg-surface disabled:opacity-50 disabled:hover:bg-ink"
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

function ContextBudgetBar(input: { usage: DesktopContextUsage }) {
  const text = useDesktopText()
  const percent = Math.max(0, Math.min(100, Math.round(input.usage.utilizationPercent)))
  const isHigh = percent >= 80
  const isCritical = percent >= 95

  return (
    <div
      className="flex items-center gap-2.5"
      title={`${input.usage.contextTokens.toLocaleString()} / ${input.usage.contextWindow.toLocaleString()} tokens`}
    >
      <div className="relative h-1.5 w-24 overflow-hidden rounded-full bg-surface">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out",
            isCritical
              ? "bg-danger"
              : isHigh
                ? "bg-amber-500"
                : "bg-accent",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span
        className={cn(
          "whitespace-nowrap text-[11px] font-medium tabular-nums",
          isCritical
            ? "text-danger"
            : isHigh
              ? "text-amber-500"
              : "text-accent",
        )}
      >
        {text.chat.contextUsed(percent)}
      </span>
    </div>
  )
}

function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}

function EmptyChatState(input: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
  errorMessage: string | null
  offsetClassName?: string
}) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        className={cn(
          "flex w-full max-w-md flex-col items-center justify-center px-6 text-center text-accent",
          input.offsetClassName,
        )}
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-border bg-paper shadow-sm">
          {input.icon}
        </div>
        <p className="text-sm font-medium tracking-wide text-muted">{input.title}</p>
        {input.action}
        {input.errorMessage ? (
          <p className="mt-3 max-w-sm text-center text-xs text-danger">{input.errorMessage}</p>
        ) : null}
      </div>
    </div>
  )
}
