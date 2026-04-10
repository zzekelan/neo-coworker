import React, { useEffect, useState } from "react"
import { cn } from "../lib/utils"
import { useDesktopText } from "../i18n"
import type { DetailItem } from "./Message"

const DEFAULT_COLLAPSED_CHAR_LIMIT = 280
const DEFAULT_COLLAPSED_LINE_LIMIT = 8
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

type ToolDetailsProps = {
  details: DetailItem[]
  emptyDetailsLabel: string
}

const ToolDetailsComponent: React.FC<ToolDetailsProps> = ({ details, emptyDetailsLabel }) => {
  if (details.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/50 bg-paper px-3 py-2 text-[12px] text-muted">
        {emptyDetailsLabel}
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-paper p-3">
      {details.map((detail, index) => (
        <ToolDetailRow key={`${detail.label}:${index}`} detail={detail} />
      ))}
    </div>
  )
}

export default React.memo(ToolDetailsComponent)

const ToolDetailRow: React.FC<{ detail: DetailItem }> = ({ detail }) => (
  <div className="flex flex-col gap-1.5">
    <div className="text-[11px] font-medium text-muted/70">{detail.label}</div>
    <div className="text-[13px] leading-6 text-ink">
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
    return <span className="italic text-accent">null</span>
  }

  if (typeof value === "string") {
    return <ExpandableFieldValue fieldName={fieldName} value={value} />
  }

  if (typeof value !== "object") {
    return <span className="whitespace-pre-wrap">{String(value)}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="italic text-accent">[]</span>
    }

    return (
      <div className={cn("flex flex-col gap-1.5", depth > 0 && "mt-1 border-l border-border/50 pl-4")}>
        {value.map((entry, index) => (
          <div key={`${fieldName ?? "item"}:${index}`} className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted">{index + 1}</span>
            <div className="break-all whitespace-pre-wrap text-ink">
              <ToolValue fieldName={fieldName} value={entry} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const entries = Object.entries(value).filter(([key]) => !HIDDEN_TOOL_KEYS.has(key))
  if (entries.length === 0) {
    return <span className="italic text-accent">{"{}"}</span>
  }

  return (
    <div className={cn("flex flex-col gap-2", depth > 0 && "mt-1 border-l border-border/50 pl-4")}>
      {entries.map(([key, nestedValue]) => (
        <div key={key} className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted">{formatDetailLabel(key, text)}</span>
          <div className="break-all whitespace-pre-wrap text-ink">
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
    const isMono = looksLikePathOrCommand(value)
    return <span className={cn("whitespace-pre-wrap", isMono && "font-mono text-[12px]")}>{value}</span>
  }

  const preview = buildCollapsedPreview(value)

  return (
    <div className="flex flex-col items-start gap-2">
      <span className="whitespace-pre-wrap">{isExpanded ? value : preview}</span>
      <button
        type="button"
        onClick={() => setIsExpanded((previous) => !previous)}
        className="rounded-md border border-border/50 bg-paper px-2 py-1 text-[11px] font-semibold tracking-wide text-muted transition-colors hover:bg-surface-hover"
      >
        {isExpanded ? text.message.showLess : text.message.showMore}
      </button>
    </div>
  )
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

/** Detect strings that look like file paths or shell commands for mono rendering. */
function looksLikePathOrCommand(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.includes("\n")) return false
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return true
  if (trimmed.length > 120) return false
  return /^[a-z_][\w.-]*[\s/]/.test(trimmed)
}
