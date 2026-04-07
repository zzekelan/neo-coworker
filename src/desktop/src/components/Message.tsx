import React, { useMemo, useState, Suspense } from "react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FilePenLine,
  FileSearch,
  FolderSearch,
  Globe,
  Loader2,
  Sparkles,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react"
import { motion } from "framer-motion"
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

const MessageComponent: React.FC<{ message: DesktopTranscriptMessage }> = ({ message }) => {
  const isUser = message.role === "user"
  const toolCallLookup = useMemo(
    () =>
      new Map(
        (message.parts ?? [])
          .filter((part): part is Extract<MessagePart, { type: "tool_call" }> => part.type === "tool_call")
          .map((part) => [part.callId, part]),
      ),
    [message.parts],
  )

  return (
    <ErrorBoundary>
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        className={cn("flex w-full flex-col", isUser ? "items-end" : "items-start")}
      >
        <div className={cn("mb-1.5 flex items-center gap-2 px-1", isUser ? "flex-row-reverse" : "flex-row")}>
          <span className="text-[11px] font-medium text-accent">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <div className={cn("flex max-w-3xl flex-col", isUser ? "items-end" : "w-full items-start")}>
          {message.parts ? (
            <div className="w-full space-y-4">
              {message.parts.map((part, index) => (
                <MessagePartRenderer
                  key={`${message.id}:${index}`}
                  part={part}
                  role={message.role}
                  relatedToolCall={part.type === "tool_result" ? toolCallLookup.get(part.callId) ?? null : null}
                />
              ))}
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
        </div>
      </motion.div>
    </ErrorBoundary>
  )
}

export const Message = React.memo(MessageComponent)

const MessagePartRenderer: React.FC<{
  part: MessagePart
  role?: DesktopTranscriptMessage["role"]
  relatedToolCall?: Extract<MessagePart, { type: "tool_call" }> | null
}> = ({ part, role, relatedToolCall = null }) => {
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
    const details = buildToolCallDetails(text, part.toolName, part.toolInput)

    return (
      <ToolActivityCard
        toolName={part.toolName}
        icon={getToolIcon(part.toolName)}
        title={describeToolCallTitle(text, part.toolName)}
        subtitle={part.progress ?? describeToolCallSummary(text, part.toolName, part.toolInput)}
        status={part.status ?? "pending"}
        details={details}
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

  const details = buildToolResultDetails(text, part.result)

  return (
    <ToolActivityCard
      toolName={relatedToolCall?.toolName}
      icon={getToolIcon(relatedToolCall?.toolName)}
      title={describeToolResultTitle(text, relatedToolCall?.toolName, part.isError)}
      subtitle={describeToolResultSummary(text, relatedToolCall?.toolName, part.result, part.isError)}
      status={part.isError ? "error" : "success"}
      details={details}
      resultTone
      emptyDetailsLabel={text.message.noAdditionalDetails}
    />
  )
}

const ToolActivityCard: React.FC<{
  toolName?: string
  icon: React.ReactNode
  title: string
  subtitle: string
  status: ToolStatus
  details: DetailItem[]
  resultTone?: boolean
  emptyDetailsLabel?: string
}> = React.memo(({ toolName, icon, title, subtitle, status, details, resultTone = false, emptyDetailsLabel }) => {
  const text = useDesktopText()
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)

  return (
    <div
      className={cn(
        "relative my-3 overflow-hidden rounded-[12px] border shadow-sm transition-colors",
        status === "error"
          ? "border-danger bg-danger/10"
          : resultTone
            ? "border-success/30 bg-success/10"
            : "border-border bg-paper",
      )}
    >
      <div
        className={cn(
          "absolute bottom-0 left-0 top-0 w-[2px] transition-colors",
          status === "pending" ? "animate-breathe bg-accent" :
          status === "success" ? "bg-success opacity-100" :
          status === "error" ? "bg-danger" : "bg-transparent"
        )}
      />
      <div className="flex items-start justify-between gap-4 px-[16px] py-[12px]">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
              status === "error"
                ? "border-danger bg-paper text-danger"
                : resultTone
                  ? "border-success/30 bg-paper text-success"
                  : "border-border bg-paper text-muted",
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink">{title}</div>
            <div className="mt-1 text-[13px] leading-6 text-muted">{subtitle}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToolStatusBadge status={status} toolName={toolName} />
        </div>
      </div>

      <div className="border-t border-border bg-paper px-[16px] py-[12px]">
        <button
          type="button"
          onClick={() => setIsDetailsOpen((previous) => !previous)}
          className="flex items-center gap-2 text-[12px] font-medium tracking-wide text-muted transition-colors hover:text-ink"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200", isDetailsOpen && "rotate-180")}
          />
          {isDetailsOpen ? text.message.hideDetails : text.message.viewDetails}
        </button>

        <motion.div
          initial={false}
          animate={{
            height: isDetailsOpen ? "auto" : 0,
            opacity: isDetailsOpen ? 1 : 0,
            marginTop: isDetailsOpen ? 12 : 0,
          }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="overflow-hidden"
        >
          {isDetailsOpen ? (
            <ErrorBoundary>
              <Suspense fallback={<PulsePlaceholder />}>
                <ToolDetails
                  details={details}
                  emptyDetailsLabel={emptyDetailsLabel ?? text.message.noAdditionalDetails}
                />
              </Suspense>
            </ErrorBoundary>
          ) : null}
        </motion.div>
      </div>
    </div>
  )
})

const ToolStatusBadge: React.FC<{ status: ToolStatus; toolName?: string }> = React.memo(({ status, toolName }) => {
  const text = useDesktopText()

  const isMutating = isToolMutating(toolName)
  
  const toolCategoryLabel = toolName ? (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[8px] py-[2px] text-[12px] font-medium uppercase tracking-wide",
        isMutating ? "bg-highlight/10 text-highlight" : "bg-surface text-muted"
      )}
    >
      {isMutating ? "mutating" : "read-only"}
    </span>
  ) : null;

  if (status === "pending") {
    return (
      <>
        {toolCategoryLabel}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-highlight/30 bg-highlight/10 px-2.5 py-1 text-[12px] font-medium text-highlight">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-highlight opacity-75"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-highlight"></span>
          </span>
          {text.message.running}
        </span>
      </>
    )
  }

  if (status === "success") {
    return (
      <>
        {toolCategoryLabel}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[12px] font-medium text-success">
          <CheckCircle2 className="h-3 w-3" />
          {text.message.completed}
        </span>
      </>
    )
  }

  if (status === "cancelled") {
    return (
      <>
        {toolCategoryLabel}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-muted">
          <XCircle className="h-3 w-3" />
          {text.message.cancelled}
        </span>
      </>
    )
  }

  return (
    <>
      {toolCategoryLabel}
      <span className="inline-flex items-center gap-1.5 rounded-full border border-danger bg-danger/10 px-2.5 py-1 text-[11px] font-semibold text-danger">
        <AlertCircle className="h-3 w-3" />
        {text.message.failed}
      </span>
    </>
  )
})

export type DetailItem = {
  label: string
  value: unknown
}

function getToolIcon(toolName: string | undefined) {
  switch (normalizeToolName(toolName)) {
    case "read":
      return <FileSearch className="h-4 w-4" />
    case "write":
    case "edit":
      return <FilePenLine className="h-4 w-4" />
    case "shell":
      return <Terminal className="h-4 w-4" />
    case "websearch":
    case "webfetch":
      return <Globe className="h-4 w-4" />
    case "codesearch":
    case "grep":
    case "glob":
      return <FolderSearch className="h-4 w-4" />
    case "skill":
      return <Sparkles className="h-4 w-4" />
    default:
      return <Wrench className="h-4 w-4" />
  }
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

function describeToolResultTitle(
  text: ReturnType<typeof useDesktopText>,
  toolName: string | undefined,
  isError: boolean | undefined,
) {
  if (isError) {
    switch (normalizeToolName(toolName)) {
      case "shell":
        return text.message.commandDidNotComplete
      case "read":
      case "write":
      case "edit":
        return text.message.fileActionDidNotComplete
      default:
        return text.message.toolActionDidNotComplete
    }
  }

  switch (normalizeToolName(toolName)) {
    case "read":
      return text.message.fileReady
    case "write":
      return text.message.fileUpdated
    case "edit":
      return text.message.editApplied
    case "shell":
      return text.message.commandFinished
    case "websearch":
      return text.message.searchFinished
    case "webfetch":
      return text.message.pageLoaded
    case "codesearch":
      return text.message.codeSearchFinished
    case "skill":
      return text.message.skillsUpdated
    default:
      return text.message.toolFinished
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

function describeToolResultSummary(
  text: ReturnType<typeof useDesktopText>,
  toolName: string | undefined,
  value: unknown,
  isError: boolean | undefined,
) {
  const summary = summarizeToolResult(text, value)
  if (summary) {
    return summary
  }

  if (isError) {
    return text.message.toolReturnedError
  }

  switch (normalizeToolName(toolName)) {
    case "read":
      return text.message.fileContentReady
    case "write":
    case "edit":
      return text.message.fileChangeApplied
    case "shell":
      return text.message.commandCompleted
    default:
      return text.message.toolCompleted
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

function summarizeToolResult(text: ReturnType<typeof useDesktopText>, value: unknown) {
  if (typeof value === "string") {
    return summarizeText(value)
  }

  if (Array.isArray(value)) {
    return text.message.returnedItems(value.length)
  }

  const parsed = asRecord(value)
  if (!parsed) {
    return value === null || value === undefined ? "" : summarizeText(String(value))
  }

  if (typeof parsed.output === "string" && parsed.output.trim()) {
    return summarizeText(parsed.output)
  }

  if (typeof parsed.stderr === "string" && parsed.stderr.trim()) {
    return summarizeText(parsed.stderr)
  }

  if (typeof parsed.stdout === "string" && parsed.stdout.trim()) {
    return summarizeText(parsed.stdout)
  }

  for (const key of ["path", "url", "query", "pattern"] as const) {
    const entry = parsed[key]
    if (typeof entry === "string" && entry.trim()) {
      return summarizeText(entry)
    }
  }

  const countKeys = ["results", "matches", "files", "items"] as const
  for (const key of countKeys) {
    const entry = parsed[key]
    if (Array.isArray(entry)) {
      return text.message.returnedNamedItems(entry.length, key.slice(0, -1), key)
    }
  }

  return ""
}

function extractPrimaryToolDetail(
  text: ReturnType<typeof useDesktopText>,
  toolName: string,
  value: unknown,
) {
  const parsed = asRecord(value)
  if (!parsed) {
    return null
  }

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

function readRecordString(value: Record<string, unknown>, key: string) {
  const candidate = value[key]
  return typeof candidate === "string" ? candidate : null
}

function summarizeText(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ""
  }

  const singleLine = trimmed.replace(/\s+/g, " ")
  if (singleLine.length <= 120) {
    return singleLine
  }

  return `${singleLine.slice(0, 117).trimEnd()}...`
}

function isToolMutating(toolName: string | undefined) {
  const name = normalizeToolName(toolName)
  return ["write", "edit", "shell", "skill"].includes(name)
}
