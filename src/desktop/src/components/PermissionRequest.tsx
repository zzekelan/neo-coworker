import React, { useEffect, useRef, useState } from "react"
import { motion } from "framer-motion"
import type { DesktopPermissionRequest } from "../view-types"
import { useDesktopText } from "../i18n"
import { cn } from "../lib/utils"

interface Props {
  request: DesktopPermissionRequest
  onReply: (id: string, decision: "allow" | "deny") => boolean | Promise<boolean>
  autoFocus?: boolean
  variant?: "card" | "composer"
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

export const PermissionRequest: React.FC<Props> = ({ request, onReply, autoFocus = false, variant = "card" }) => {
  const cardRef = useRef<HTMLDivElement>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const text = useDesktopText()
  const isComposer = variant === "composer"

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
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
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
      className={cn(
        "relative overflow-hidden border border-border shadow-sm",
        isComposer
          ? "min-h-[132px] rounded-2xl bg-paper px-4 py-3"
          : "my-6 max-w-3xl rounded-xl bg-surface px-5 py-4",
      )}
    >
      <div className={`absolute bottom-0 left-0 top-0 w-[3px] ${risk.colorClass}`} />
      
      <div className="mb-2 flex items-center gap-2">
        {isComposer ? (
          <span className="text-[13px] font-semibold text-ink">
            {text.permission.title}
          </span>
        ) : null}
        <span className={cn("font-semibold text-ink", isComposer && "text-[13px] text-muted")}>
          {request.toolName}
        </span>
        <span className={`rounded-full bg-border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${risk.textClass}`}>
          {risk.label}
        </span>
      </div>

      <div className={cn(
        "font-mono text-[13px] text-muted break-all",
        isComposer ? "mb-5 leading-relaxed" : "mb-4",
      )}>
        {argsText}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => void submitReply("deny")}
          className="rounded-md bg-transparent px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-border/50"
        >
          {text.permission.deny}
        </button>
        <button
          type="button"
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
