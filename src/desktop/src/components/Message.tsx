import React from "react"
import { AlertCircle, CheckCircle2, Loader2, Terminal } from "lucide-react"
import { motion } from "framer-motion"
import { cn } from "../lib/utils"
import type { DesktopTranscriptMessage, MessagePart } from "../view-types"
import { MarkdownText } from "./MarkdownText"

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

const renderToolData = (data: unknown, depth = 0): React.ReactNode => {
  if (data === null || data === undefined) {
    return <span className="italic text-zinc-400">null</span>
  }

  if (typeof data !== "object") {
    return <span className="whitespace-pre-wrap">{String(data)}</span>
  }

  return (
    <div className={cn("flex flex-col gap-1.5", depth > 0 && "mt-1 border-l border-zinc-200 pl-4")}>
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="flex flex-col items-start sm:flex-row sm:gap-4">
          <span className="min-w-[120px] shrink-0 pt-0.5 font-medium text-zinc-500">{key}:</span>
          <span className="flex-1 break-all whitespace-pre-wrap text-zinc-800">
            {typeof value === "object" && value !== null ? renderToolData(value, depth + 1) : String(value)}
          </span>
        </div>
      ))}
    </div>
  )
}

const MessagePartRenderer: React.FC<{
  part: MessagePart
  role?: DesktopTranscriptMessage["role"]
}> = ({ part, role }) => {
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
          </div>
        </div>
        <div className="overflow-x-auto bg-white p-4 text-zinc-700">{renderToolData(part.toolInput)}</div>
      </div>
    )
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-zinc-200 bg-white font-mono text-xs shadow-sm">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2 font-semibold text-zinc-500">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Result
      </div>
      <div className="max-h-64 overflow-x-auto p-4 text-zinc-700">{renderToolData(part.result)}</div>
    </div>
  )
}
