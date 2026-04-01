import React, { useEffect, useMemo, useState } from "react"
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
import { MarkdownText } from "./MarkdownText"

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

export const Message: React.FC<{ message: DesktopTranscriptMessage }> = ({ message }) => {
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
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("mb-6 flex w-full flex-col", isUser ? "items-end" : "items-start")}
    >
      <div className={cn("mb-1.5 flex items-center gap-2 px-1", isUser ? "flex-row-reverse" : "flex-row")}>
        <span className="text-[11px] font-medium text-zinc-400">
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
                ? "rounded-2xl rounded-tr-sm bg-zinc-100 px-5 py-3 text-zinc-900"
                : "py-2 text-zinc-800",
            )}
          >
            {isUser ? (
              <div className="whitespace-pre-wrap">{message.content}</div>
            ) : (
              <MarkdownText text={message.content} />
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
}

const MessagePartRenderer: React.FC<{
  part: MessagePart
  role?: DesktopTranscriptMessage["role"]
  relatedToolCall?: Extract<MessagePart, { type: "tool_call" }> | null
}> = ({ part, role, relatedToolCall = null }) => {
  const text = useDesktopText()

  if (part.type === "text") {
    if (role === "assistant") {
      return <MarkdownText text={part.text} className="py-1 text-[15px]" />
    }

    return <div className="py-1 whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-800">{part.text}</div>
  }

  if (part.type === "tool_call") {
    const details = buildToolCallDetails(text, part.toolName, part.toolInput)

    return (
      <ToolActivityCard
        icon={getToolIcon(part.toolName)}
        title={describeToolCallTitle(text, part.toolName)}
        subtitle={describeToolCallSummary(text, part.toolName, part.toolInput)}
        status={part.status ?? "pending"}
        details={details}
      />
    )
  }

  const details = buildToolResultDetails(text, part.result)

  return (
    <ToolActivityCard
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
  icon: React.ReactNode
  title: string
  subtitle: string
  status: ToolStatus
  details: DetailItem[]
  resultTone?: boolean
  emptyDetailsLabel?: string
}> = ({ icon, title, subtitle, status, details, resultTone = false, emptyDetailsLabel }) => {
  const text = useDesktopText()
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)

  return (
    <div
      className={cn(
        "my-3 overflow-hidden rounded-2xl border shadow-sm transition-colors",
        status === "error"
          ? "border-rose-200 bg-rose-50/60"
          : resultTone
            ? "border-emerald-200 bg-emerald-50/50"
            : "border-zinc-200 bg-zinc-50/80",
      )}
    >
      <div className="flex items-start justify-between gap-4 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
              status === "error"
                ? "border-rose-200 bg-white text-rose-500"
                : resultTone
                  ? "border-emerald-200 bg-white text-emerald-500"
                  : "border-zinc-200 bg-white text-zinc-600",
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-zinc-900">{title}</div>
            <div className="mt-1 text-[13px] leading-6 text-zinc-600">{subtitle}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToolStatusBadge status={status} />
        </div>
      </div>

      <div className="border-t border-zinc-200/80 bg-white/75 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setIsDetailsOpen((previous) => !previous)}
          className="flex items-center gap-2 text-[12px] font-medium tracking-wide text-zinc-500 transition-colors hover:text-zinc-800"
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
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          {details.length > 0 ? (
            <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/80 p-3">
              {details.map((detail, index) => (
                <ToolDetailRow key={`${detail.label}:${index}`} detail={detail} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/60 px-3 py-2 text-[12px] text-zinc-500">
              {emptyDetailsLabel ?? text.message.noAdditionalDetails}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

const ToolStatusBadge: React.FC<{ status: ToolStatus }> = ({ status }) => {
  const text = useDesktopText()

  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-600">
        <Loader2 className="h-3 w-3 animate-spin" />
        {text.message.running}
      </span>
    )
  }

  if (status === "success") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">
        <CheckCircle2 className="h-3 w-3" />
        {text.message.completed}
      </span>
    )
  }

  if (status === "cancelled") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold text-zinc-500">
        <XCircle className="h-3 w-3" />
        {text.message.cancelled}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-600">
      <AlertCircle className="h-3 w-3" />
      {text.message.failed}
    </span>
  )
}

type DetailItem = {
  label: string
  value: unknown
}

const ToolDetailRow: React.FC<{ detail: DetailItem }> = ({ detail }) => (
  <div className="flex flex-col gap-1.5">
    <div className="text-[11px] font-semibold tracking-[0.18em] text-zinc-400 uppercase">{detail.label}</div>
    <div className="text-[13px] leading-6 text-zinc-700">
            <ToolValue fieldName={detail.label} value={detail.value} />
    </div>
  </div>
)

const ToolValue: React.FC<{
  fieldName: string | null
  value: unknown
  depth?: number
}> = ({ fieldName, value, depth = 0 }) => {
  const text = useDesktopText()

  if (value === null || value === undefined) {
    return <span className="italic text-zinc-400">null</span>
  }

  if (typeof value === "string") {
    return <ExpandableFieldValue fieldName={fieldName} value={value} />
  }

  if (typeof value !== "object") {
    return <span className="whitespace-pre-wrap">{String(value)}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="italic text-zinc-400">[]</span>
    }

    return (
      <div className={cn("flex flex-col gap-1.5", depth > 0 && "mt-1 border-l border-zinc-200 pl-4")}>
        {value.map((entry, index) => (
          <div key={`${fieldName ?? "item"}:${index}`} className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-zinc-500">{index + 1}</span>
            <div className="break-all whitespace-pre-wrap text-zinc-800">
              <ToolValue fieldName={fieldName} value={entry} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value).filter(([key]) => !HIDDEN_TOOL_KEYS.has(key))
  if (entries.length === 0) {
    return <span className="italic text-zinc-400">{"{}"}</span>
  }

  return (
    <div className={cn("flex flex-col gap-2", depth > 0 && "mt-1 border-l border-zinc-200 pl-4")}>
      {entries.map(([key, nestedValue]) => (
        <div key={key} className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-zinc-500">{formatDetailLabel(key, text)}</span>
          <div className="break-all whitespace-pre-wrap text-zinc-800">
            <ToolValue fieldName={key} value={nestedValue} depth={depth + 1} />
          </div>
        </div>
      ))}
    </div>
  )
}

const ExpandableFieldValue: React.FC<{
  fieldName: string | null
  value: string
}> = ({ fieldName, value }) => {
  const text = useDesktopText()
  const isCollapsedByDefault = shouldCollapseFieldValue(fieldName, value)
  const [isExpanded, setIsExpanded] = useState(!isCollapsedByDefault)

  useEffect(() => {
    setIsExpanded(!isCollapsedByDefault)
  }, [fieldName, isCollapsedByDefault, value])

  if (!isCollapsedByDefault) {
    return <span className="whitespace-pre-wrap">{value}</span>
  }

  const preview = buildCollapsedPreview(value)

  return (
    <div className="flex flex-col items-start gap-2">
      <span className="whitespace-pre-wrap">{isExpanded ? value : preview}</span>
      <button
        type="button"
        onClick={() => setIsExpanded((previous) => !previous)}
        className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] font-semibold tracking-wide text-zinc-600 transition-colors hover:bg-zinc-100"
      >
        {isExpanded ? text.message.showLess : text.message.showMore}
      </button>
    </div>
  )
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

function shouldCollapseFieldValue(fieldName: string | null, value: string) {
  if (!value) {
    return false
  }

  const normalizedFieldName = fieldName?.toLowerCase() ?? null
  const lineCount = value.split("\n").length
  const isLargePatchText = /^diff --git |^@@ |^\+\+\+ |^--- /m.test(value)
  const isLongValue =
    value.length > DEFAULT_COLLAPSED_CHAR_LIMIT || lineCount > DEFAULT_COLLAPSED_LINE_LIMIT

  if (isLargePatchText) {
    return true
  }

  if (
    normalizedFieldName &&
    ["details", "output", "error details", "additional data"].includes(normalizedFieldName) &&
    (value.length > 72 || lineCount > 1)
  ) {
    return true
  }

  return isLongValue
}

function buildCollapsedPreview(value: string) {
  const lines = value.split("\n")
  const limitedLines = lines.slice(0, DEFAULT_COLLAPSED_LINE_LIMIT).join("\n")
  const limitedText = limitedLines.slice(0, DEFAULT_COLLAPSED_CHAR_LIMIT).trimEnd()
  const wasTruncated =
    lines.length > DEFAULT_COLLAPSED_LINE_LIMIT || limitedLines.length > DEFAULT_COLLAPSED_CHAR_LIMIT

  return wasTruncated ? `${limitedText}\n...` : limitedText
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
