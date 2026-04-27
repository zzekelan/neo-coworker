import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowUp,
  ChevronDown,
  MessageSquare,
  Moon,
  PanelLeft,
  Play,
  Plus,
  Sparkles,
  Square,
  Sun,
  Zap,
} from "lucide-react"
import { AnimatePresence, motion } from "framer-motion"
import type {
  DesktopContextUsage,
  DesktopPermissionRequest,
  DesktopPrimaryAgent,
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
import { AgentBadge } from "./AgentBadge"
import { AgentSelector } from "./AgentSelector"
import { useDesktopText } from "../i18n"
import { useTheme } from "../providers/ThemeProvider"

const SKILL_DRAWER_TRANSITION = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
}
const TRANSCRIPT_BOTTOM_SAFE_AREA = 42

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
  compatibilityPrompt: CompatibilityPromptView | null
  onStartNewSessionFromCompatibility: () => void
  onContinueWithoutThinking: () => void
  modelName?: string
  currentAgent: string
  primaryAgents: DesktopPrimaryAgent[]
  onSetAgent: (agentName: string) => void
}

export type CompatibilityPromptView = {
  kind: "legacy_session_missing_reasoning"
  sessionId: string
  runId: string
  rawError: string
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
  compatibilityPrompt,
  onStartNewSessionFromCompatibility,
  onContinueWithoutThinking,
  modelName,
  currentAgent,
  primaryAgents,
  onSetAgent,
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
  const [pendingSkills, setPendingSkills] = useState<string[]>([])
  const [isAgentSelectorOpen, setIsAgentSelectorOpen] = useState(false)
  const agentSelectorShellRef = useRef<HTMLDivElement>(null)
  const scrollToBottomRef = useRef<(() => void) | null>(null)
  const bottomCardObserverRef = useRef<ResizeObserver | null>(null)
  const [bottomCardHeight, setBottomCardHeight] = useState(160)

  const bottomCardRef = useCallback((element: HTMLDivElement | null) => {
    bottomCardObserverRef.current?.disconnect()
    bottomCardObserverRef.current = null
    if (!element) return
    setBottomCardHeight(element.offsetHeight)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0]
        const height = box
          ? box.blockSize
          : entry.target instanceof HTMLElement
            ? entry.target.offsetHeight
            : entry.contentRect.height
        setBottomCardHeight(Math.ceil(height))
      }
    })
    observer.observe(element)
    bottomCardObserverRef.current = observer
  }, [])

  useEffect(() => () => {
    bottomCardObserverRef.current?.disconnect()
    bottomCardObserverRef.current = null
  }, [])

  const skillPanelShellRef = useRef<HTMLDivElement>(null)
  const sessionSkillQueueRef = useRef<{
    sessionId: string | null
    queue: SkillUpdateQueue | null
  }>({
    sessionId: null,
    queue: null,
  })
  const activeRunStatus = session?.activeRun?.status ?? null
  const activeRunId = session?.activeRun?.id ?? null
  const isRunning = activeRunStatus === "running"
  const isBusy = isBusyRunStatus(activeRunStatus)
  const isRunSkillEditingLocked = Boolean(session?.activeRun)
  const activePermissionRequest = permissionRequests[0] ?? null
  const hasActiveToolCall = useMemo(
    () => hasPendingToolCall(transcript, activeRunId),
    [transcript, activeRunId],
  )
  const hasActiveReasoningPart = useMemo(
    () => hasVisibleReasoningPart(transcript, activeRunId),
    [transcript, activeRunId],
  )
  const showThinkingIndicator = isRunning && !hasActiveToolCall && !hasActiveReasoningPart
  const footerRunStatus = activeRunStatus === "running" || activeRunStatus === "queued" ? null : activeRunStatus
  const finishedRunNotice = getFinishedRunNotice(session?.activeRun?.id ?? null, session?.latestRun?.status ?? null)
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
  const currentAgentLabel = primaryAgents.find((agent) => agent.name === currentAgent)?.displayName || currentAgent

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
    setPendingSkills([])
  }, [sessionSummary?.id])

  useEffect(() => {
    setIsSkillPanelOpen(false)
    setSkillFilter("")
    setIsAgentSelectorOpen(false)
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

  useEffect(() => {
    if (!isAgentSelectorOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!agentSelectorShellRef.current?.contains(event.target as Node)) {
        setIsAgentSelectorOpen(false)
      }
    }

    const handleCloseOverlays = () => {
      setIsAgentSelectorOpen(false)
    }

    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("close-overlays", handleCloseOverlays)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("close-overlays", handleCloseOverlays)
    }
  }, [isAgentSelectorOpen])

  const handleAgentSelect = useCallback((agentName: string) => {
    onSetAgent(agentName)
    setIsAgentSelectorOpen(false)
  }, [onSetAgent])

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
      setPendingSkills([])
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

  const handlePermissionReply = useCallback((requestId: string, decision: "allow" | "deny") => {
    scrollToBottomRef.current?.()
    return onReplyPermission(requestId, decision)
  }, [onReplyPermission])

  const handleStartSkill = useCallback(async (skillName: string) => {
    setPendingSkills((prev) => (prev.includes(skillName) ? prev : [...prev, skillName]))
    await updateSkillSet(skillName, true)
  }, [updateSkillSet])

  const handleCancelPendingSkill = useCallback(async (skillName: string) => {
    setPendingSkills((prev) => prev.filter((name) => name !== skillName))
    await updateSkillSet(skillName, false)
  }, [updateSkillSet])

  const isInputLocked = isBusy || isSubmittingMessage

  if (!sessionSummary) {
    return (
      <div className="relative flex flex-1 flex-col bg-paper">
        <div className="chrome-edge-bottom sticky top-0 z-10 flex h-14 items-center justify-between bg-paper px-4 md:px-6">
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
            {hasSessions ? (
              <h2 className="font-semibold tracking-tight text-ink">
                {text.chat.selectSession}
              </h2>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggleButton />
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto px-4 md:px-8"
          style={{ paddingBottom: bottomCardHeight + TRANSCRIPT_BOTTOM_SAFE_AREA }}
        >
          <EmptyChatState
            icon={<Play className="h-6 w-6 text-accent" />}
            title={hasSessions ? text.chat.selectSession : text.chat.createSessionToStart}
            offsetClassName="translate-y-2"
            action={
              !hasSessions ? (
                <button
                  type="button"
                  onClick={() => void onCreateSession()}
                  className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-paper px-4 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-paper hover:text-ink"
                >
                  <Plus className="h-4 w-4" />
                  {text.chat.createSession}
                </button>
              ) : null
            }
            errorMessage={errorMessage}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-1 flex-col bg-paper">
      <div className="chrome-edge-bottom sticky top-0 z-10 flex h-14 items-center justify-between bg-paper px-4 md:px-6">
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
        </div>
      </div>

      {transcript.length === 0 ? (
        <div
          className="flex-1 overflow-y-auto px-4 md:px-8"
          style={{ paddingBottom: bottomCardHeight + TRANSCRIPT_BOTTOM_SAFE_AREA }}
        >
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
          className="px-4 md:px-8"
          bottomInset={bottomCardHeight + TRANSCRIPT_BOTTOM_SAFE_AREA}
          scrollButtonOffset={bottomCardHeight + 16}
          renderItem={(message, index) => {
            const boundaryPart = message.parts?.find((p) => p.type === "compaction_boundary")
            const prevTimestamp = index > 0 ? transcript[index - 1].createdAt : undefined
            return (
              <div className="mx-auto max-w-[54rem]">
                {boundaryPart && boundaryPart.type === "compaction_boundary" ? (
                  <CompactionDivider
                    tokensBefore={boundaryPart.tokensBefore}
                    tokensAfter={boundaryPart.tokensAfter}
                  />
                ) : (
                  <Message
                    message={message}
                    previousTimestamp={prevTimestamp}
                    isActiveRunMessage={message.runId === activeRunId && isRunning}
                    waitingPermissionToolName={
                      message.runId === activeRunId ? activePermissionRequest?.toolName ?? null : null
                    }
                  />
                )}
              </div>
            )
          }}
          footer={
            <div className="mx-auto max-w-[54rem]">
              {compatibilityPrompt ? (
                <div
                  role="alertdialog"
                  aria-label={text.compatibility.legacySessionTitle}
                  className="mb-4 rounded-xl border border-danger bg-danger/10 px-4 py-3 text-sm text-danger"
                >
                  <p className="font-semibold">{text.compatibility.legacySessionTitle}</p>
                  <p className="mt-1 text-ink/80">{text.compatibility.legacySessionMessage}</p>
                  <p className="mt-2 text-xs text-ink/70">
                    {text.compatibility.continueWithoutThinkingHint}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={onContinueWithoutThinking}
                      className="rounded-md border border-border bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface"
                    >
                      {text.compatibility.continueWithoutThinking}
                    </button>
                    <button
                      type="button"
                      onClick={onStartNewSessionFromCompatibility}
                      className="rounded-md border border-danger bg-danger px-3 py-1.5 text-xs font-medium text-paper hover:opacity-90"
                    >
                      {text.compatibility.startNewSession}
                    </button>
                  </div>
                </div>
              ) : null}

              {errorMessage ? (
                <div className="mb-4 rounded-xl border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
                  {errorMessage}
                </div>
              ) : null}

              {activePermissionRequest ? (
                <PermissionRequest
                  key={activePermissionRequest.id}
                  request={activePermissionRequest}
                  autoFocus
                  onReply={handlePermissionReply}
                />
              ) : null}

              {finishedRunNotice ? (
                <RunFinishedNotice label={finishedRunNotice === "cancelled" ? text.chat.runFinishedCancelled : text.chat.runFinishedFailed} />
              ) : null}

              {showThinkingIndicator ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="flex items-center py-3"
                  role="status"
                  aria-live="polite"
                  aria-label={text.message.thinking}
                >
                  <span className="text-[13px] font-medium leading-5 text-muted/70">
                    {text.message.thinking}
                  </span>
                </motion.div>
              ) : null}
            </div>
          }
        />
      )}

       <div className="pointer-events-none absolute right-0 bottom-0 left-0 bg-paper px-4 pb-1.5">
        <motion.div ref={bottomCardRef} layout transition={SKILL_DRAWER_TRANSITION} className="pointer-events-auto relative mx-auto max-w-4xl bg-paper">
          <div ref={skillPanelShellRef}>
            <AnimatePresence initial={false}>
              {isSkillPanelOpen ? (
                <motion.div
                  key="skill-panel-shell"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12 }}
                  transition={SKILL_DRAWER_TRANSITION}
                  className="pointer-events-none absolute bottom-full left-0 right-0 mb-2"
                >
                  <div className="pointer-events-auto w-1/4 min-w-[200px]">
                      <SkillPanel
                        skills={skills}
                        query={skillFilter}
                        session={sessionSummaryWithOptimisticSkills}
                        activeRun={session?.activeRun}
                        controlsDisabled={isRunSkillEditingLocked}
                        busySkillName={busySkillName}
                        errorMessage={skillErrorMessage}
                        warningMessage={skillWarningMessage}
                        pendingSkills={pendingSkills}
                        onStartSkill={handleStartSkill}
                        onCancelPendingSkill={handleCancelPendingSkill}
                      />
                    <div className="mb-1">
                      <input
                        value={skillFilter}
                        onChange={(event) => setSkillFilter(event.target.value)}
                        placeholder={text.chat.filterSkills}
                        className="h-9 w-full rounded-lg border border-border bg-paper px-3 text-[12px] text-ink shadow-sm outline-none transition-colors placeholder:text-accent focus:border-border"
                      />
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <motion.form
            layout
            transition={SKILL_DRAWER_TRANSITION}
            onSubmit={handleSubmit}
            className={cn(
              "relative flex flex-col rounded-2xl border bg-paper shadow-sm transition-all",
              isBusy
                ? "border-border"
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
              aria-label={text.chat.askPlaceholder}
              className="min-h-[96px] max-h-64 flex-1 resize-none border-0 bg-transparent px-4 pt-3 pb-2 text-[15px] leading-relaxed text-ink placeholder:text-accent outline-none focus:ring-0"
              rows={2}
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

            <div className="flex items-center justify-between mx-2 px-0.5 pt-1 pb-1.5">
              <div className="flex items-center gap-2">
                <div ref={agentSelectorShellRef} className="relative">
                  <AgentBadge
                    agentLabel={currentAgentLabel}
                    isOpen={isAgentSelectorOpen}
                    onClick={() => setIsAgentSelectorOpen((prev) => !prev)}
                  />
                  <AgentSelector
                    isOpen={isAgentSelectorOpen}
                    agents={primaryAgents}
                    currentAgent={currentAgent}
                    onSelect={handleAgentSelect}
                  />
                </div>

                {skills.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsSkillPanelOpen((previous) => !previous)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium transition-colors",
                        isSkillPanelOpen
                          ? "bg-surface text-ink"
                          : "text-accent hover:bg-surface hover:text-ink",
                      )}
                    >
                      <Sparkles className="h-3 w-3" />
                      {text.chat.skills}
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", !isSkillPanelOpen && "rotate-180")}
                      />
                    </button>

                    {visibleActiveSkills.length > 0 ? (
                      visibleActiveSkills.map((skillName) => (
                        <span
                          key={skillName}
                          className="inline-flex items-center gap-1 rounded-md bg-highlight/10 px-1.5 py-0.5 text-[11px] font-medium text-highlight"
                        >
                          <Zap className="h-2.5 w-2.5" />
                          {skillName}
                        </span>
                      ))
                    ) : null}
                  </>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                {isBusy ? (
                  <button
                    type="button"
                    onClick={() => void onCancelRun()}
                    className="rounded-lg border border-danger/30 bg-danger/10 p-2 text-danger transition-colors hover:bg-danger/20"
                    title="Cancel Run"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || isComposing || isSubmittingMessage}
                    className="rounded-lg bg-ink p-2 text-paper shadow-sm transition-colors hover:bg-surface hover:text-ink disabled:opacity-50 disabled:hover:bg-ink disabled:hover:text-paper"
                  >
                    <ArrowUp className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>
          </motion.form>

          {/* Status bar — context · model · run status · keyboard hints */}
          <div className="mt-1.5 flex h-6 items-center justify-between px-1 text-[11px] text-accent">
            <div className="flex min-w-0 items-center gap-1.5">
              <ContextBudgetBar usage={contextUsage} />
              {modelName ? (
                <>
                  <span className="text-muted/40">·</span>
                  <span className="shrink-0 text-accent" title={modelName}>{modelName}</span>
                </>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              <RunStatusDot status={footerRunStatus} />
              <span className="text-muted/60 select-none">
                ⏎ {text.chat.send} · ⇧⏎ {text.chat.newLine}
              </span>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

function hasPendingToolCall(transcript: DesktopTranscriptMessage[], activeRunId: string | null) {
  if (!activeRunId) {
    return false
  }

  return transcript.some((message) => {
    if (message.runId !== activeRunId) {
      return false
    }

    const parts = message.parts ?? []
    const resolvedCallIds = new Set(
      parts
        .filter((part) => part.type === "tool_result")
        .map((part) => part.callId),
    )

    return parts.some((part) => {
      if (part.type !== "tool_call") {
        return false
      }

      return !resolvedCallIds.has(part.callId)
        && part.status !== "success"
        && part.status !== "error"
        && part.status !== "cancelled"
    })
  })
}

function hasVisibleReasoningPart(transcript: DesktopTranscriptMessage[], activeRunId: string | null) {
  if (!activeRunId) {
    return false
  }

  return transcript.some((message) => {
    if (message.runId !== activeRunId) {
      return false
    }

    return (message.parts ?? []).some((part) => part.type === "reasoning" && part.text.trim().length > 0)
  })
}

function getFinishedRunNotice(activeRunId: string | null, latestRunStatus: string | null | undefined) {
  if (activeRunId) {
    return null
  }

  if (latestRunStatus === "cancelled" || latestRunStatus === "failed") {
    return latestRunStatus
  }

  return null
}

function RunFinishedNotice({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex items-center gap-2 py-3 text-[13px] font-medium text-muted"
      role="status"
      aria-live="polite"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden="true" />
      {label}
    </motion.div>
  )
}

function ContextBudgetBar(input: { usage: DesktopContextUsage | null }) {
  const text = useDesktopText()
  const { usage } = input
  const contextTokens = normalizeUsageNumber(usage?.contextTokens)
  const contextWindow = normalizeUsageNumber(usage?.contextWindow)
  const percent = usage && contextWindow > 0
    ? Math.max(0, Math.min(100, Math.round(normalizeUsageNumber(usage.utilizationPercent))))
    : 0
  const isHigh = percent >= 80
  const isCritical = percent >= 95
  const title = usage && contextWindow > 0
    ? `${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`
    : text.chat.contextUsed(0)

  return (
    <div
      className="flex items-center gap-1.5"
      title={title}
    >
      <div className="relative h-1 w-16 overflow-hidden rounded-full bg-surface">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out",
            isCritical
              ? "bg-danger"
              : isHigh
                ? "bg-highlight"
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
              ? "text-highlight"
              : "text-accent",
        )}
      >
        {text.chat.contextUsed(percent)}
      </span>
    </div>
  )
}

function normalizeUsageNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0
  }

  return Math.trunc(value)
}

type RunStatus = string | null

function RunStatusDot({ status }: { status: RunStatus }) {
  const text = useDesktopText()

  if (!status || status === "completed") {
    return null
  }

  if (status === "running" || status === "queued") {
    return (
      <span className="flex items-center gap-1.5" role="status" aria-live="polite">
        <span className="h-1.5 w-1.5 rounded-full bg-highlight animate-breathe" aria-hidden="true" />
        <span className="font-medium text-highlight">{text.chat.runStatusRunning}</span>
      </span>
    )
  }

  if (status === "waiting_permission") {
    return (
      <span className="flex items-center gap-1.5" role="status" aria-live="polite">
        <span className="h-1.5 w-1.5 rounded-full bg-highlight animate-breathe" aria-hidden="true" />
        <span className="font-medium text-highlight">{text.chat.runStatusWaiting}</span>
      </span>
    )
  }

  if (status === "failed") {
    return (
      <span className="flex items-center gap-1.5" role="status" aria-live="polite">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" aria-hidden="true" />
        <span className="font-medium text-danger">{text.chat.runStatusFailed}</span>
      </span>
    )
  }

  if (status === "cancelled") {
    return (
      <span className="flex items-center gap-1.5" role="status" aria-live="polite">
        <span className="h-1.5 w-1.5 rounded-full bg-muted" aria-hidden="true" />
        <span className="font-medium text-muted">{text.chat.runStatusCancelled}</span>
      </span>
    )
  }

  return null
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
    <div className="relative h-full w-full">
      <div
        className="absolute top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-8 px-6 text-center text-accent"
      >
        <div
          className={cn(
            "flex flex-col items-center justify-center",
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
    </div>
  )
}
