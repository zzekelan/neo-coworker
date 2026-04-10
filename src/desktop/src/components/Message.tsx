import React, { useCallback, useMemo, useState, Suspense } from "react"
import {
  AlertCircle,
  Check,
  ChevronLeft,
  Copy,
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "../lib/utils"
import type { DesktopTranscriptMessage, MessagePart } from "../view-types"
import { useDesktopText } from "../i18n"
import { ErrorBoundary } from "./ErrorBoundary"
import { CompactionDivider } from "./CompactionDivider"

const MarkdownText = React.lazy(() => import("./MarkdownText"))
const ToolDetails = React.lazy(() => import("./ToolDetails"))

const PulsePlaceholder = () => <div className="pulse-placeholder" />

const DEFAULT_COLLAPSED_CHAR_LIMIT = 280
const DEFAULT_COLLAPSED_LINE_LIMIT = 8
const TOOL_DETAIL_KEYS = [
  "path",
  "paths",
  "query",
  "pattern",
  "url",
  "command",
  "reason",
  "justification",
  "model",
  "workspaceRoot",
] as const
const HIDDEN_TOOL_KEYS = new Set([
  "callId",
  "toolName",
  "inputText",
  "output",
  "stdout",
  "stderr",
  "content",
  "diff",
  "patch",
  "source",
])

type ToolStatus = Extract<MessagePart, { type: "tool_call" }>["status"]

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>
type ToolResultPart = Extract<MessagePart, { type: "tool_result" }>

type RenderItem =
  | { kind: "single"; part: MessagePart; index: number }
  | {
      kind: "group"
      entries: Array<{
        part: ToolCallPart
        result: ToolResultPart | null
        isError: boolean
        isCancelled: boolean
      }>
      normalizedName: string
      startIndex: number
    }

function formatTimestampToMinute(createdAt: string): string {
  return new Date(createdAt).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const MessageComponent: React.FC<{
  message: DesktopTranscriptMessage
  previousTimestamp?: string
}> = ({ message, previousTimestamp }) => {
  const text = useDesktopText()
  const isUser = message.role === "user"
  const toolResultLookup = useMemo(
    () =>
      new Map(
        (message.parts ?? [])
          .filter((part): part is ToolResultPart => part.type === "tool_result")
          .map((part) => [part.callId, part]),
      ),
    [message.parts],
  )

  const copyableText = useMemo(() => {
    if (message.parts) {
      return message.parts
        .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n")
    }
    return message.content
  }, [message.parts, message.content])

  const formattedTimestamp = formatTimestampToMinute(message.createdAt)
  const showTimestamp = !previousTimestamp || formatTimestampToMinute(previousTimestamp) !== formattedTimestamp

  /** Group consecutive completed tool_call parts of the same normalized type. */
  const renderItems = useMemo((): RenderItem[] => {
    const filtered = (message.parts ?? []).filter((p) => p.type !== "tool_result")
    const items: RenderItem[] = []
    let i = 0
    while (i < filtered.length) {
      const part = filtered[i]
      if (part.type === "tool_call") {
        const norm = normalizeToolName(part.toolName)
        const result = toolResultLookup.get(part.callId) ?? null
        const isCompleted = result !== null
        const isCancelled = part.status === "cancelled"

        if (isCompleted || isCancelled) {
          const group: RenderItem extends { kind: "group" } ? never : Array<{
            part: ToolCallPart
            result: ToolResultPart | null
            isError: boolean
            isCancelled: boolean
          }> = [{
            part,
            result,
            isError: (result?.isError ?? false) && !isCancelled,
            isCancelled,
          }]
          let j = i + 1
          while (j < filtered.length) {
            const next = filtered[j]
            if (next.type !== "tool_call") break
            if (normalizeToolName(next.toolName) !== norm) break
            const nextResult = toolResultLookup.get(next.callId) ?? null
            const nextCompleted = nextResult !== null
            const nextCancelled = next.status === "cancelled"
            if (!nextCompleted && !nextCancelled) break
            group.push({
              part: next,
              result: nextResult,
              isError: (nextResult?.isError ?? false) && !nextCancelled,
              isCancelled: nextCancelled,
            })
            j++
          }

          if (group.length >= 2) {
            items.push({ kind: "group", entries: group, normalizedName: norm, startIndex: i })
          } else {
            items.push({ kind: "single", part, index: i })
          }
          i = j
          continue
        }
      }
      items.push({ kind: "single", part, index: i })
      i++
    }
    return items
  }, [message.parts, toolResultLookup])

  return (
    <ErrorBoundary>
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className={cn("flex w-full flex-col", isUser ? "items-end" : "items-start", copyableText && "group/msg")}
      >
        {showTimestamp ? (
          <div className={cn("mb-1.5 flex items-center gap-2 px-1", isUser ? "flex-row-reverse" : "flex-row")}>
            <span className="text-[11px] font-medium text-accent">
              {formattedTimestamp}
            </span>
          </div>
        ) : null}

        <div className={cn("flex max-w-3xl flex-col", isUser ? "items-end" : "w-full items-start")}>
          {message.parts ? (
            <div className="w-full space-y-2">
              {renderItems.map((item) => {
                if (item.kind === "group") {
                  return (
                    <ToolCallGroup
                      key={`${message.id}:grp:${item.entries[0].part.callId}`}
                      entries={item.entries}
                      normalizedName={item.normalizedName}
                      startIndex={item.startIndex}
                    />
                  )
                }
                const part = item.part
                return (
                  <MessagePartRenderer
                    key={part.type === "tool_call" ? `${message.id}:tc:${part.callId}` : `${message.id}:${part.type}:${item.index}`}
                    part={part}
                    role={message.role}
                    relatedResult={part.type === "tool_call" ? toolResultLookup.get(part.callId) ?? null : null}
                    partIndex={item.index}
                  />
                )
              })}
            </div>
          ) : (
            <div
              className={cn(
                "text-[15px] leading-relaxed",
                isUser
                  ? "rounded-2xl rounded-tr-sm bg-surface px-5 py-3 text-ink"
                  : "py-2 text-ink",
              )}
            >
              {isUser ? (
                <div className="whitespace-pre-wrap">{message.content}</div>
              ) : (
                <ErrorBoundary>
                  <Suspense fallback={<PulsePlaceholder />}>
                    <MarkdownText text={message.content} />
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          )}

          {copyableText ? (
            <CopyMessageButton text={copyableText} label={text.chat.copyMessage} copiedLabel={text.chat.copied} failedLabel={text.chat.clipboardUnavailable} />
          ) : null}
        </div>
      </motion.div>
    </ErrorBoundary>
  )
}

export const Message = React.memo(MessageComponent)

function CopyMessageButton({ text, label, copiedLabel, failedLabel }: { text: string; label: string; copiedLabel: string; failedLabel: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopyState("copied")
        setTimeout(() => setCopyState("idle"), 2000)
      },
      () => {
        setCopyState("failed")
        setTimeout(() => setCopyState("idle"), 2000)
      },
    )
  }, [text])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "mt-1 rounded-md p-1 transition-all duration-150",
        copyState === "copied"
          ? "text-success opacity-100"
          : copyState === "failed"
            ? "text-danger opacity-100"
            : "text-muted opacity-0 hover:bg-surface hover:text-ink group-hover/msg:opacity-100",
      )}
      title={copyState === "copied" ? copiedLabel : copyState === "failed" ? failedLabel : label}
      aria-label={copyState === "copied" ? copiedLabel : copyState === "failed" ? failedLabel : label}
    >
      {copyState === "copied" ? <Check className="h-3.5 w-3.5" /> :
       copyState === "failed" ? <AlertCircle className="h-3.5 w-3.5" /> :
       <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

const MessagePartRenderer: React.FC<{
  part: MessagePart
  role?: DesktopTranscriptMessage["role"]
  relatedResult?: Extract<MessagePart, { type: "tool_result" }> | null
  partIndex?: number
}> = ({ part, role, relatedResult = null, partIndex = 0 }) => {
  const text = useDesktopText()

  if (part.type === "text") {
    if (role === "assistant") {
      return (
        <ErrorBoundary>
          <Suspense fallback={<PulsePlaceholder />}>
            <MarkdownText text={part.text} className="py-1 text-[15px]" />
          </Suspense>
        </ErrorBoundary>
      )
    }

    return <div className="py-1 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{part.text}</div>
  }

  if (part.type === "tool_call") {
    const isCompleted = relatedResult !== null
    const isCancelled = part.status === "cancelled"
    const isError = relatedResult?.isError ?? false
    const finalStatus: ToolStatus = isCancelled ? "cancelled" : isCompleted ? (isError ? "error" : "success") : (part.status ?? "pending")

    const callDetails = buildToolCallDetails(text, part.toolName, part.toolInput)
    const resultDetails = isCompleted ? buildToolResultDetails(text, relatedResult.result) : []
    const allDetails = [...callDetails, ...resultDetails]

    if (isCompleted || isCancelled) {
      return (
        <CompletedToolRow
          toolName={part.toolName}
          toolInput={part.toolInput}
          isError={isError && !isCancelled}
          isCancelled={isCancelled}
          details={allDetails}
          partIndex={partIndex}
          isAgent={isAgentTool(part.toolName)}
        />
      )
    }

    return (
      <ToolIndicator
        title={describeToolCallTitle(text, part.toolName)}
        subtitle={part.progress ?? describeToolCallSummary(text, part.toolName, part.toolInput)}
        status={finalStatus}
        details={callDetails}
        partIndex={partIndex}
        isAgent={isAgentTool(part.toolName)}
      />
    )
  }

  if (part.type === "compaction_boundary") {
    return (
      <CompactionDivider
        tokensBefore={part.tokensBefore}
        tokensAfter={part.tokensAfter}
      />
    )
  }

  // tool_result parts are filtered out before reaching here
  return null
}

/** Collapsible group for ≥2 consecutive completed tool calls of the same type. */
const ToolCallGroup: React.FC<{
  entries: Array<{
    part: ToolCallPart
    result: ToolResultPart | null
    isError: boolean
    isCancelled: boolean
  }>
  normalizedName: string
  startIndex: number
}> = React.memo(({ entries, normalizedName, startIndex }) => {
  const text = useDesktopText()
  const [isExpanded, setIsExpanded] = useState(entries.length <= 3)

  const isAgent = isAgentTool(entries[0].part.toolName)
  const errorCount = entries.filter((e) => e.isError).length
  const cancelledCount = entries.filter((e) => e.isCancelled).length
  const hasAnyError = errorCount > 0
  const allCancelled = cancelledCount === entries.length

  const groupLabel = describeToolGroupLabel(text, entries[0].part.toolName)

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay: Math.min(startIndex * 0.05, 0.5) }}
      className={cn(
        "relative",
        isAgent && "ml-2 border-l-2 border-highlight/20 pl-3",
        hasAnyError && !isAgent && "border-l-2 border-danger pl-2",
      )}
    >
      {/* Group header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="group/ghdr flex w-full items-center gap-1.5 py-0.5 text-left"
      >
        <div className="flex min-w-0 flex-1 items-center">
          <span className={cn(
            "min-w-0 truncate text-[13px] leading-snug",
            allCancelled ? "text-muted/50 italic" : "text-muted",
          )}>
            {groupLabel}
          </span>
          <span className="ml-1.5 shrink-0 text-[13px] leading-snug font-medium text-muted/70">
            ({entries.length})
          </span>
          {hasAnyError ? (
            <span className="ml-1.5 shrink-0 text-[12px] leading-snug text-danger/80">
              · {errorCount} failed
            </span>
          ) : null}
        </div>
        <div className="flex w-5 shrink-0 items-center justify-center">
          <ChevronLeft
            className={cn(
              "h-3 w-3 text-muted/30 transition-all duration-200 group-hover/ghdr:text-muted/60",
              isExpanded && "rotate-[-90deg]",
            )}
          />
        </div>
      </button>

      {/* Expanded sub-items with clean indentation */}
      <AnimatePresence initial={false}>
        {isExpanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="ml-4 mt-0.5 border-l border-border/40 pl-3">
              {entries.map((entry) => {
                const callDetails = buildToolCallDetails(text, entry.part.toolName, entry.part.toolInput)
                const resultDetails = entry.result ? buildToolResultDetails(text, entry.result.result) : []
                const allDetails = [...callDetails, ...resultDetails]

                return (
                  <CompletedToolRow
                    key={entry.part.callId}
                    toolName={entry.part.toolName}
                    toolInput={entry.part.toolInput}
                    isError={entry.isError}
                    isCancelled={entry.isCancelled}
                    details={allDetails}
                    partIndex={0}
                    isAgent={false}
                    skipEntrance
                  />
                )
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  )
})

const ToolIndicator: React.FC<{
  title: string
  subtitle: string
  status: ToolStatus
  details: DetailItem[]
  partIndex?: number
  isAgent?: boolean
}> = React.memo(({ title, subtitle, status, details, partIndex = 0, isAgent = false }) => {
  const text = useDesktopText()
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)

  const hasDetails = details.length > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay: Math.min(partIndex * 0.05, 0.5) }}
      className={cn("relative", isAgent && "ml-2 border-l-2 border-highlight/20 pl-3")}
    >
      {/* Indicator row */}
      <div className="relative flex items-center gap-2 py-1.5">
        {/* Title · Subtitle · Status — single line, truncated */}
        <div className="flex min-w-0 flex-1 items-center">
          <span className="shrink-0 text-[13px] font-medium leading-snug text-ink">
            {title}
          </span>
          <span className="mx-1.5 text-muted leading-snug select-none">·</span>
          <span className="min-w-0 truncate text-[13px] leading-snug text-muted">
            {subtitle}
          </span>
          <span className="ml-2 shrink-0" role="status" aria-live="polite">
            <ToolStatusBadge status={status} />
          </span>
        </div>

        {/* Expand chevron */}
        <div className="flex w-5 shrink-0 items-center justify-center">
          {hasDetails ? (
            <button
              type="button"
              onClick={() => setIsDetailsOpen((previous) => !previous)}
              className="rounded-md p-0.5 text-muted/30 transition-colors hover:text-muted/60"
              aria-label={isDetailsOpen ? text.message.hideDetails : text.message.viewDetails}
            >
              <ChevronLeft
                className={cn(
                  "h-3 w-3 transition-all duration-200",
                  isDetailsOpen && "rotate-[-90deg]",
                )}
              />
            </button>
          ) : null}
        </div>
      </div>

      {/* Expanded details panel */}
      <motion.div
        initial={false}
        animate={{
          height: isDetailsOpen ? "auto" : 0,
          opacity: isDetailsOpen ? 1 : 0,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="overflow-hidden"
      >
        {isDetailsOpen ? (
          <div className="border-l border-border/30 ml-1 pl-3 pb-2">
            <ErrorBoundary>
              <Suspense fallback={<PulsePlaceholder />}>
                <ToolDetails
                  details={details}
                  emptyDetailsLabel={text.message.noAdditionalDetails}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        ) : null}
      </motion.div>
    </motion.div>
  )
})

const ToolStatusBadge: React.FC<{ status: ToolStatus }> = React.memo(({ status }) => {
  const text = useDesktopText()

  if (status === "pending") {
    return (
      <span className="animate-breathe text-[12px] font-medium text-highlight">
        {text.message.running}
      </span>
    )
  }

  if (status === "success") {
    return null
  }

  if (status === "cancelled") {
    return (
      <span className="text-[12px] font-medium text-muted/50">
        {text.message.cancelled}
      </span>
    )
  }

  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="text-[12px] font-medium text-danger/80"
    >
      {text.message.failed}
    </motion.span>
  )
})

const CompletedToolRow: React.FC<{
  toolName: string
  toolInput: unknown
  isError: boolean
  isCancelled: boolean
  details: DetailItem[]
  partIndex?: number
  isAgent?: boolean
  skipEntrance?: boolean
}> = React.memo(({ toolName, toolInput, isError, isCancelled, details, partIndex = 0, isAgent = false, skipEntrance = false }) => {
  const text = useDesktopText()
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)
  const hasDetails = details.length > 0

  const summary = describeCompletedToolSummary(text, toolName, toolInput)
  const failSuffix = isError ? ` — ${text.message.failedSuffix}` : ""

  return (
    <motion.div
      initial={skipEntrance ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={skipEntrance ? { duration: 0 } : { duration: 0.2, ease: "easeOut", delay: Math.min(partIndex * 0.05, 0.5) }}
      className={cn(
        "relative",
        isAgent && "ml-2 border-l-2 border-highlight/20 pl-3",
        isError && !isAgent && "border-l-2 border-danger pl-2",
      )}
    >
      <div className="relative flex items-center gap-1.5 py-0.5">
        <div className="flex min-w-0 flex-1 items-center">
          <span className={cn(
            "min-w-0 truncate text-[13px] leading-snug",
            isCancelled
              ? "text-muted/50 italic"
              : isError
                ? "text-danger/80"
                : "text-muted",
          )}>
            {summary}
          </span>
          {failSuffix ? (
            <span className="ml-1 shrink-0 text-[12px] leading-snug text-danger/60">
              {failSuffix}
            </span>
          ) : null}
        </div>

        <div className="flex w-5 shrink-0 items-center justify-center">
          {hasDetails ? (
            <button
              type="button"
              onClick={() => setIsDetailsOpen((previous) => !previous)}
              className="rounded-md p-0.5 text-muted/30 transition-colors hover:text-muted/60"
              aria-label={isDetailsOpen ? text.message.hideDetails : text.message.viewDetails}
            >
              <ChevronLeft
                className={cn(
                  "h-3 w-3 transition-all duration-200",
                  isDetailsOpen && "rotate-[-90deg]",
                )}
              />
            </button>
          ) : null}
        </div>
      </div>

      {/* Expanded details panel */}
      <motion.div
        initial={false}
        animate={{
          height: isDetailsOpen ? "auto" : 0,
          opacity: isDetailsOpen ? 1 : 0,
        }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="overflow-hidden"
      >
        {isDetailsOpen ? (
          <div className="border-l border-border/30 ml-1 pl-3 pb-2">
            <ErrorBoundary>
              <Suspense fallback={<PulsePlaceholder />}>
                <ToolDetails
                  details={details}
                  emptyDetailsLabel={text.message.noAdditionalDetails}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        ) : null}
      </motion.div>
    </motion.div>
  )
})

export type DetailItem = {
  label: string
  value: unknown
}

function describeToolCallTitle(text: ReturnType<typeof useDesktopText>, toolName: string) {
  switch (normalizeToolName(toolName)) {
    case "read":
      return text.message.readingFile
    case "write":
      return text.message.writingFile
    case "edit":
      return text.message.editingFile
    case "shell":
      return text.message.runningCommand
    case "websearch":
      return text.message.searchingWeb
    case "webfetch":
      return text.message.openingWebpage
    case "codesearch":
      return text.message.searchingCodebase
    case "grep":
      return text.message.scanningFiles
    case "glob":
      return text.message.findingMatchingFiles
    case "skill":
      return text.message.updatingSkills
    default:
      return text.message.usingTool(formatToolDisplayName(toolName))
  }
}

function describeToolCallSummary(
  text: ReturnType<typeof useDesktopText>,
  toolName: string,
  value: unknown,
) {
  const detail = extractPrimaryToolDetail(text, toolName, value)
  if (detail) {
    return detail
  }

  switch (normalizeToolName(toolName)) {
    case "read":
      return text.message.openingFileContents
    case "write":
      return text.message.savingFileChanges
    case "edit":
      return text.message.applyingFocusedEdit
    case "shell":
      return text.message.executingShellCommand
    case "websearch":
      return text.message.lookingUpWebInfo
    case "webfetch":
      return text.message.loadingWebpage
    case "codesearch":
      return text.message.searchingRepoCode
    case "grep":
      return text.message.scanningMatchingText
    case "glob":
      return text.message.lookingForMatchingFiles
    case "skill":
      return text.message.updatingSkills
    default:
      return text.message.toolWorking
  }
}

function describeCompletedToolSummary(
  text: ReturnType<typeof useDesktopText>,
  toolName: string,
  toolInput: unknown,
): string {
  const detail = extractCompactToolDetail(toolName, toolInput)
  const name = normalizeToolName(toolName)

  switch (name) {
    case "read":
      return detail ? text.message.completedRead(detail) : text.message.completedReadFallback
    case "write":
      return detail ? text.message.completedWrote(detail) : text.message.completedWroteFallback
    case "edit":
      return detail ? text.message.completedEdited(detail) : text.message.completedEditedFallback
    case "shell":
      return detail ? text.message.completedRan(detail) : text.message.completedRanFallback
    case "websearch":
      return detail ? text.message.completedSearched(detail) : text.message.completedSearchedFallback
    case "webfetch":
      return detail ? text.message.completedFetched(detail) : text.message.completedFetchedFallback
    case "codesearch":
      return detail ? text.message.completedCodeSearch(detail) : text.message.completedCodeSearchFallback
    case "grep":
      return detail ? text.message.completedScanned(detail) : text.message.completedScannedFallback
    case "glob":
      return detail ? text.message.completedFound(detail) : text.message.completedFoundFallback
    case "skill":
      return text.message.completedSkills
    default: {
      if (name.includes("agent")) {
        return detail ? text.message.completedAgent(detail) : text.message.completedAgentFallback
      }
      return detail ? text.message.completedGenericTool(formatToolDisplayName(toolName), detail) : formatToolDisplayName(toolName)
    }
  }
}

/** Returns the generic fallback label for a tool type (e.g. "Searched the web") used in group headers. */
function describeToolGroupLabel(
  text: ReturnType<typeof useDesktopText>,
  toolName: string,
): string {
  const name = normalizeToolName(toolName)
  switch (name) {
    case "read":
      return text.message.completedReadFallback
    case "write":
      return text.message.completedWroteFallback
    case "edit":
      return text.message.completedEditedFallback
    case "shell":
      return text.message.completedRanFallback
    case "websearch":
      return text.message.completedSearchedFallback
    case "webfetch":
      return text.message.completedFetchedFallback
    case "codesearch":
      return text.message.completedCodeSearchFallback
    case "grep":
      return text.message.completedScannedFallback
    case "glob":
      return text.message.completedFoundFallback
    case "skill":
      return text.message.completedSkills
    default: {
      if (name.includes("agent")) {
        return text.message.completedAgentFallback
      }
      return formatToolDisplayName(toolName)
    }
  }
}

/** Try to extract structured args from the tool_call data (args may be JSON-encoded in inputText). */
function parseToolArgs(data: Record<string, unknown>): Record<string, unknown> {
  // Direct keys take priority (some tools store args at top level)
  if (data.path || data.query || data.pattern || data.url || data.command) {
    return data
  }
  // Tool_call parts store args as a JSON string in inputText
  const inputText = data.inputText
  if (typeof inputText === "string") {
    try {
      const args = JSON.parse(inputText)
      if (args && typeof args === "object" && !Array.isArray(args)) {
        return args as Record<string, unknown>
      }
    } catch { /* not valid JSON, ignore */ }
  }
  return data
}

/** Extracts a compact primary identifier (bare path, command, query) without decorative prose. */
function extractCompactToolDetail(toolName: string, value: unknown): string | null {
  const raw = asRecord(value)
  if (!raw) return null
  const parsed = parseToolArgs(raw)

  const path = readRecordString(parsed, "path")
  const query = readRecordString(parsed, "query")
  const pattern = readRecordString(parsed, "pattern")
  const url = readRecordString(parsed, "url")
  const command = readRecordString(parsed, "command")

  switch (normalizeToolName(toolName)) {
    case "read":
    case "write":
    case "edit":
      return path ?? null
    case "shell":
      return command ? truncateShellCommand(command) : null
    case "websearch":
      return query ?? null
    case "webfetch":
      return url ? truncateUrl(url) : null
    case "codesearch":
      return query ?? null
    case "grep":
      return pattern ?? query ?? null
    case "glob":
      return pattern ?? null
    default:
      return path ?? query ?? pattern ?? url ?? command ?? null
  }
}

function truncateShellCommand(command: string): string {
  const clean = command.trim().replace(/\s+/g, " ")
  return clean.length <= 60 ? clean : `${clean.slice(0, 57)}...`
}

function truncateUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const short = parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "")
    return short.length <= 50 ? short : `${short.slice(0, 47)}...`
  } catch {
    return url.length <= 50 ? url : `${url.slice(0, 47)}...`
  }
}

function buildToolCallDetails(
  text: ReturnType<typeof useDesktopText>,
  toolName: string,
  value: unknown,
) {
  const parsed = asRecord(value)
  if (!parsed) {
    return []
  }

  return TOOL_DETAIL_KEYS.flatMap((key) => {
    const detailValue = parsed[key]
    if (detailValue === undefined || HIDDEN_TOOL_KEYS.has(key)) {
      return []
    }

    return [{ label: formatDetailLabel(key, text), value: detailValue }]
  })
}

function buildToolResultDetails(text: ReturnType<typeof useDesktopText>, value: unknown) {
  if (typeof value === "string") {
    return value.trim() ? [{ label: text.message.details, value }] : []
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? [{ label: text.message.items, value }] : []
  }

  const parsed = asRecord(value)
  if (!parsed) {
    return value === null || value === undefined ? [] : [{ label: text.message.details, value: String(value) }]
  }

  const details: DetailItem[] = []

  if (typeof parsed.output === "string" && parsed.output.trim()) {
    details.push({ label: text.message.details, value: parsed.output })
  }

  if (typeof parsed.stdout === "string" && parsed.stdout.trim()) {
    details.push({ label: text.message.output, value: parsed.stdout })
  }

  if (typeof parsed.stderr === "string" && parsed.stderr.trim()) {
    details.push({ label: text.message.errorDetails, value: parsed.stderr })
  }

  for (const key of TOOL_DETAIL_KEYS) {
    const detailValue = parsed[key]
    if (detailValue === undefined || HIDDEN_TOOL_KEYS.has(key)) {
      continue
    }
    details.push({ label: formatDetailLabel(key, text), value: detailValue })
  }

  const remainingEntries = Object.entries(parsed).filter(
    ([key]) =>
      !HIDDEN_TOOL_KEYS.has(key) &&
      !TOOL_DETAIL_KEYS.includes(key as (typeof TOOL_DETAIL_KEYS)[number]),
  )
  if (remainingEntries.length > 0) {
    details.push({ label: text.message.additionalData, value: Object.fromEntries(remainingEntries) })
  }

  return details
}

function extractPrimaryToolDetail(
  text: ReturnType<typeof useDesktopText>,
  toolName: string,
  value: unknown,
) {
  const raw = asRecord(value)
  if (!raw) {
    return null
  }
  const parsed = parseToolArgs(raw)

  const path = readRecordString(parsed, "path")
  const query = readRecordString(parsed, "query")
  const pattern = readRecordString(parsed, "pattern")
  const url = readRecordString(parsed, "url")
  const command = readRecordString(parsed, "command")

  switch (normalizeToolName(toolName)) {
    case "read":
      return path ? text.message.openingPath(path) : null
    case "write":
      return path ? text.message.savingPath(path) : null
    case "edit":
      return path ? text.message.editingPath(path) : null
    case "shell":
      return command ? text.message.runningCommandText(command) : null
    case "websearch":
      return query ? text.message.searchingFor(query) : null
    case "webfetch":
      return url ? text.message.openingUrl(url) : null
    case "codesearch":
      return query ? text.message.lookingForCode(query) : null
    case "grep":
      return pattern
        ? text.message.findingMatches(pattern)
        : query
          ? text.message.findingMatches(query)
          : null
    case "glob":
      return pattern ? text.message.findingMatches(pattern) : null
    default:
      return path ?? query ?? pattern ?? url ?? command ?? null
  }
}

function normalizeToolName(toolName: string | undefined) {
  if (!toolName) {
    return "unknown"
  }

  if (toolName === "read_file") {
    return "read"
  }

  return toolName
}

function isAgentTool(toolName: string | undefined): boolean {
  const name = normalizeToolName(toolName)
  return name.includes("agent")
}

function formatToolDisplayName(toolName: string) {
  return toolName.replaceAll("_", " ")
}

function formatDetailLabel(key: string, text?: ReturnType<typeof useDesktopText>) {
  if (key === "workspaceRoot") {
    return text?.message.workspace ?? "Workspace"
  }

  return key
    .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function readRecordString(value: Record<string, unknown> | null, key: string) {
  if (!value) return null
  const candidate = value[key]
  return typeof candidate === "string" ? candidate : null
}


