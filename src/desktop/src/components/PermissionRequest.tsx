import React, { useEffect, useRef, useState } from "react"
import { motion } from "framer-motion"
import type { DesktopPermissionRequest } from "../view-types"
import { useDesktopText } from "../i18n"

interface Props {
  request: DesktopPermissionRequest
  onReply: (id: string, decision: "allow" | "deny") => boolean | Promise<boolean>
  autoFocus?: boolean
}

function getRiskIndicator(toolName: string) {
  if (toolName === "shell") {
    return { colorClass: "bg-danger", textClass: "text-danger", label: "shell" }
  }
  if (["write", "edit", "remove"].includes(toolName)) {
    return { colorClass: "bg-highlight", textClass: "text-highlight", label: "mutating" }
  }
  if (["webfetch", "websearch", "codesearch", "read", "glob", "grep"].includes(toolName)) {
    return { colorClass: "bg-success", textClass: "text-success", label: "read-only" }
  }
  return { colorClass: "bg-highlight", textClass: "text-highlight", label: "mutating" }
}

export const PermissionRequest: React.FC<Props> = ({ request, onReply, autoFocus = false }) => {
  const cardRef = useRef<HTMLDivElement>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const text = useDesktopText()

  useEffect(() => {
    if (!autoFocus) {
      return
    }

    cardRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (request.status !== "pending") {
      setIsSubmitting(false)
    }
  }, [request.id, request.status])

  if (request.status !== "pending") {
    return null
  }

  const submitReply = async (decision: "allow" | "deny") => {
    if (isSubmitting) {
      return
    }

    setIsSubmitting(true)
    const applied = await onReply(request.id, decision)
    if (applied === false) {
      setIsSubmitting(false)
    }
  }

  const risk = getRiskIndicator(request.toolName)
  const argsText =
    request.reason.length > 80
      ? request.reason.slice(0, 80) + "…"
      : request.reason

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (isSubmitting) {
          return
        }

        if (event.key === "Enter") {
          event.preventDefault()
          void submitReply("allow")
        }

        if (event.key === "Escape") {
          event.preventDefault()
          void submitReply("deny")
        }
      }}
      className="relative my-6 max-w-3xl overflow-hidden rounded-[12px] border border-border bg-surface px-[20px] py-[16px] shadow-sm"
    >
      <div className={`absolute bottom-0 left-0 top-0 w-[3px] ${risk.colorClass}`} />
      
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-ink">{request.toolName}</span>
        <span className={`rounded-full bg-border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${risk.textClass}`}>
          {risk.label}
        </span>
      </div>

      <div className="mb-4 font-mono text-[13px] text-muted break-all">
        {argsText}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          disabled={isSubmitting}
          onClick={() => void submitReply("deny")}
          className="rounded-md bg-transparent px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-border/50"
        >
          {text.permission.deny}
        </button>
        <button
          disabled={isSubmitting}
          onClick={() => void submitReply("allow")}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-paper transition-colors hover:opacity-90"
        >
          {text.permission.allow}
        </button>
      </div>
    </motion.div>
  )
}
