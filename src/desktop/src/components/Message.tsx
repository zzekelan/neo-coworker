import React, { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, Terminal, XCircle } from "lucide-react"
import { motion } from "framer-motion"
import { cn } from "../lib/utils"
import type { DesktopTranscriptMessage, MessagePart } from "../view-types"
import { useDesktopText } from "../i18n"
import { MarkdownText } from "./MarkdownText"

const DEFAULT_COLLAPSED_CHAR_LIMIT = 280
const DEFAULT_COLLAPSED_LINE_LIMIT = 8
const NOISY_TOOL_FIELDS = new Set([
  "command",
  "content",
  "diff",
  "inputText",
  "output",
  "patch",
  "stderr",
  "stdout",
])

export const Message: React.FC<{ message: DesktopTranscriptMessage }> = ({ message }) => {
  const isUser = message.role === "user"

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
              <MessagePartRenderer key={`${message.id}:${index}`} part={part} role={message.role} />
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
}> = ({ part, role }) => {
  const text = useDesktopText()

  if (part.type === "text") {
    if (role === "assistant") {
      return <MarkdownText text={part.text} className="py-1 text-[15px]" />
    }

    return <div className="py-1 whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-800">{part.text}</div>
  }

  if (part.type === "tool_call") {
    return (
      <div className="my-3 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 font-mono text-xs shadow-sm">
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-100/50 px-4 py-2.5">
          <div className="flex items-center gap-2.5 text-zinc-600">
            <Terminal className="h-4 w-4" />
            <span className="font-semibold text-zinc-700">{part.toolName}</span>
          </div>
          <div>
            {part.status === "pending" ? <Loader2 className="h-4 w-4 animate-spin text-indigo-500" /> : null}
            {part.status === "success" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
            {part.status === "error" ? <AlertCircle className="h-4 w-4 text-rose-500" /> : null}
            {part.status === "cancelled" ? <XCircle className="h-4 w-4 text-zinc-400" /> : null}
          </div>
        </div>
        <div className="overflow-x-auto bg-white p-4 text-zinc-700">
          <ToolValue fieldName={null} value={part.toolInput} />
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "my-3 overflow-hidden rounded-xl border bg-white font-mono text-xs shadow-sm",
        part.isError ? "border-rose-200" : "border-zinc-200",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-4 py-2 font-semibold",
          part.isError
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : "border-zinc-200 bg-zinc-50 text-zinc-500",
        )}
      >
        {part.isError ? (
          <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        )}{" "}
        {part.isError ? text.message.error : text.message.result}
      </div>
      <div className="max-h-64 overflow-x-auto p-4 text-zinc-700">
        <ToolValue fieldName={null} value={part.result} />
      </div>
    </div>
  )
}

const ToolValue: React.FC<{
  fieldName: string | null
  value: unknown
  depth?: number
}> = ({ fieldName, value, depth = 0 }) => {
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
          <div key={`${fieldName ?? "item"}:${index}`} className="flex flex-col items-start sm:flex-row sm:gap-4">
            <span className="min-w-[120px] shrink-0 pt-0.5 font-medium text-zinc-500">{index}:</span>
            <div className="flex-1 break-all whitespace-pre-wrap text-zinc-800">
              <ToolValue fieldName={fieldName} value={entry} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value)
  if (entries.length === 0) {
    return <span className="italic text-zinc-400">{"{}"}</span>
  }

  return (
    <div className={cn("flex flex-col gap-1.5", depth > 0 && "mt-1 border-l border-zinc-200 pl-4")}>
      {entries.map(([key, nestedValue]) => (
        <div key={key} className="flex flex-col items-start sm:flex-row sm:gap-4">
          <span className="min-w-[120px] shrink-0 pt-0.5 font-medium text-zinc-500">{key}:</span>
          <div className="flex-1 break-all whitespace-pre-wrap text-zinc-800">
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

function shouldCollapseFieldValue(fieldName: string | null, value: string) {
  if (!value) {
    return false
  }

  const lineCount = value.split("\n").length
  const isLargePatchText = /^diff --git |^@@ |^\+\+\+ |^--- /m.test(value)
  const isNoisyField = fieldName !== null && NOISY_TOOL_FIELDS.has(fieldName)
  const isLongValue =
    value.length > DEFAULT_COLLAPSED_CHAR_LIMIT || lineCount > DEFAULT_COLLAPSED_LINE_LIMIT

  if (isLargePatchText) {
    return true
  }

  if (isNoisyField && (value.length > 72 || lineCount > 1)) {
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
