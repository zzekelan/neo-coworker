import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDown } from "lucide-react"
import { cn } from "../lib/utils"

interface VirtualTimelineItem {
  id: string
}

interface VirtualTimelineProps<T extends VirtualTimelineItem> {
  messages: T[]
  renderItem: (item: T, index: number) => React.ReactNode
  estimatedItemHeight?: number
  overscan?: number
  className?: string
  footer?: React.ReactNode
  scrollToBottomRef?: { current: ((() => void) | null) }
  bottomInset?: number
  scrollButtonOffset?: number
}

export function VirtualTimeline<T extends VirtualTimelineItem>({
  messages,
  renderItem,
  estimatedItemHeight = 100,
  overscan = 5,
  className,
  footer,
  scrollToBottomRef: externalScrollRef,
  bottomInset,
  scrollButtonOffset,
}: VirtualTimelineProps<T>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const previousCountRef = useRef(messages.length)
  const [isAtBottom, setIsAtBottom] = useState(true)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedItemHeight,
    overscan,
  })

  const virtualItems = virtualizer.getVirtualItems()

  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true
    setIsAtBottom(true)
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" })
    }
  }, [virtualizer, messages.length])

  useEffect(() => {
    if (externalScrollRef) {
      externalScrollRef.current = scrollToBottom
    }
  }, [externalScrollRef, scrollToBottom])

  useEffect(() => {
    if (messages.length > previousCountRef.current && stickToBottomRef.current) {
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(messages.length - 1, { align: "end" })
      })
    }
    previousCountRef.current = messages.length
  }, [messages.length, virtualizer])

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [virtualizer.getTotalSize()])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom <= 48
    stickToBottomRef.current = nearBottom
    setIsAtBottom(nearBottom)
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const el = scrollContainerRef.current
      if (!el) return
      if (event.key === "ArrowDown") {
        event.preventDefault()
        el.scrollBy({ top: 80, behavior: "smooth" })
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        el.scrollBy({ top: -80, behavior: "smooth" })
      } else if (event.key === "End") {
        event.preventDefault()
        scrollToBottom()
      } else if (event.key === "Home") {
        event.preventDefault()
        el.scrollTo({ top: 0, behavior: "smooth" })
      }
    },
    [scrollToBottom],
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        className={cn("timeline-scroll-container h-full overflow-y-auto outline-none", className)}
        style={{ overflowAnchor: "none" }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualItems.map((virtualRow) => {
            const item = messages[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderItem(item, virtualRow.index)}
              </div>
            )
          })}
        </div>
        {footer}
        {bottomInset !== undefined ? (
          <div
            aria-hidden="true"
            className="timeline-bottom-spacer"
            style={{ height: bottomInset }}
          />
        ) : null}
      </div>

      <ScrollToBottomButton
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
        offset={scrollButtonOffset}
      />
    </div>
  )
}

const ScrollToBottomButton = React.memo(function ScrollToBottomButton({
  visible,
  onClick,
  offset,
}: {
  visible: boolean
  onClick: () => void
  offset?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to bottom"
      style={offset !== undefined ? { bottom: offset } : undefined}
      className={cn(
        "absolute left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center",
        offset === undefined ? "bottom-36" : undefined,
        "rounded-full border border-border bg-surface text-ink shadow-lg",
        "transition-all duration-200 ease-out hover:bg-surface-hover hover:shadow-xl",
        visible ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <ChevronDown className="h-4 w-4" />
    </button>
  )
})
