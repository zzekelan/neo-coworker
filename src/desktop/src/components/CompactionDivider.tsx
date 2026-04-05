import { motion } from "framer-motion"
import { Minimize2 } from "lucide-react"
import { useDesktopText } from "../i18n"

interface CompactionDividerProps {
  tokensBefore: number
  tokensAfter: number
}

export function CompactionDivider({ tokensBefore, tokensAfter }: CompactionDividerProps) {
  const text = useDesktopText()

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="my-6 flex items-center gap-3"
    >
      <div className="h-px flex-1 bg-zinc-200" />
      <div className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1">
        <Minimize2 className="h-3 w-3 text-zinc-400" />
        <span className="text-[11px] font-medium text-zinc-500">
          {text.chat.sessionCompacted}
        </span>
        {tokensBefore > 0 ? (
          <>
            <span className="text-[11px] text-zinc-300">·</span>
            <span className="text-[11px] tabular-nums text-zinc-400">
              {text.chat.compactionSaved(tokensBefore, tokensAfter)}
            </span>
          </>
        ) : null}
      </div>
      <div className="h-px flex-1 bg-zinc-200" />
    </motion.div>
  )
}
