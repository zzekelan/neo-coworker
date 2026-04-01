import React, { useEffect, useRef, useState } from "react"
import { Check, ShieldAlert, X } from "lucide-react"
import { motion } from "framer-motion"
import type { DesktopPermissionRequest } from "../view-types"
import { useDesktopText } from "../i18n"

interface Props {
  request: DesktopPermissionRequest
  onReply: (id: string, decision: "allow" | "deny") => boolean | Promise<boolean>
  autoFocus?: boolean
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
      className="my-6 max-w-3xl rounded-xl border border-zinc-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-100 bg-amber-50">
          <ShieldAlert className="h-5 w-5 text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="mb-1 text-base font-semibold text-zinc-900">{text.permission.title}</h3>
          <p className="mb-4 text-sm leading-relaxed text-zinc-500">
            {text.permission.requestTool(request.toolName)}
          </p>

          <div className="mb-5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
            {request.reason}
          </div>

          <div className="flex items-center gap-3">
            <button
              disabled={isSubmitting}
              onClick={() => void submitReply("allow")}
              className="flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-zinc-800"
            >
              <Check className="h-4 w-4" />
              {text.permission.allow}
            </button>
            <button
              disabled={isSubmitting}
              onClick={() => void submitReply("deny")}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
            >
              <X className="h-4 w-4" />
              {text.permission.deny}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
