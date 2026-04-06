import React, { useEffect, useRef, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { useKeyboardShortcuts } from "../providers/KeyboardShortcutProvider"

export function CommandPalette() {
  const { isCommandPaletteOpen, setIsCommandPaletteOpen, registry } = useKeyboardShortcuts()
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const commands = Array.from(registry.entries()).map(([keyCombo, item]) => ({
    keyCombo,
    label: item.label,
    handler: item.handler,
  }))

  const filteredCommands = commands.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase())
  )

  useEffect(() => {
    if (isCommandPaletteOpen) {
      setQuery("")
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [isCommandPaletteOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const selected = filteredCommands[selectedIndex]
      if (selected) {
        setIsCommandPaletteOpen(false)
        selected.handler()
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setIsCommandPaletteOpen(false)
    }
  }

  const formatKeyCombo = (combo: string) => {
    return combo
      .split("+")
      .map((k) => {
        if (k === "meta") return "⌘"
        if (k === "shift") return "⇧"
        if (k === "alt") return "⌥"
        if (k === "control") return "⌃"
        return k.toUpperCase()
      })
      .join(" ")
  }

  return (
    <AnimatePresence>
      {isCommandPaletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-black/60"
            onClick={() => setIsCommandPaletteOpen(false)}
          />

          <motion.div
            data-testid="command-palette"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="relative z-50 w-full max-w-[600px] overflow-hidden rounded-xl border shadow-2xl"
            style={{ 
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)"
            }}
          >
            <div 
              className="flex items-center border-b px-4 py-3"
              style={{ borderColor: "var(--color-border)" }}
            >
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setSelectedIndex(0)
                }}
                onKeyDown={handleKeyDown}
                placeholder="Type a command or search..."
                className="w-full bg-transparent text-[16px] outline-none"
                style={{ color: "var(--color-ink)" }}
              />
            </div>

            <div className="max-h-[300px] overflow-y-auto py-2">
              {filteredCommands.length === 0 ? (
                <div 
                  className="py-6 text-center text-sm"
                  style={{ color: "var(--color-muted)" }}
                >
                  No commands found.
                </div>
              ) : (
                <ul className="px-2">
                  {filteredCommands.map((command, index) => {
                    const isSelected = index === selectedIndex
                    return (
                      <li
                        key={command.keyCombo}
                        className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors"
                        style={{
                          backgroundColor: isSelected ? "var(--color-highlight)" : "transparent",
                          color: "var(--color-ink)"
                        }}
                        onClick={() => {
                          setIsCommandPaletteOpen(false)
                          command.handler()
                        }}
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <span>{command.label}</span>
                        <div className="flex items-center gap-1 text-xs">
                          {formatKeyCombo(command.keyCombo).split(" ").map((keyChar, i) => (
                            <kbd
                              key={i}
                              className="rounded px-1.5 py-0.5 font-mono"
                              style={{
                                backgroundColor: isSelected ? "var(--color-surface)" : "var(--color-paper)",
                                color: isSelected ? "var(--color-ink)" : "var(--color-muted)",
                                border: isSelected ? "none" : "1px solid var(--color-border)"
                              }}
                            >
                              {keyChar}
                            </kbd>
                          ))}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
