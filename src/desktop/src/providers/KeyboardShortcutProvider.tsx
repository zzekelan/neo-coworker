import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react"
import { useTheme } from "./ThemeProvider"

export type ShortcutHandler = {
  handler: () => void
  label: string
  when?: () => boolean
}

interface KeyboardShortcutContextValue {
  registerShortcut: (key: string, shortcut: ShortcutHandler) => () => void
  isCommandPaletteOpen: boolean
  setIsCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>
  registry: Map<string, ShortcutHandler>
  closeAllOverlays: () => void
}

const KeyboardShortcutContext = createContext<KeyboardShortcutContextValue | null>(null)

export function useKeyboardShortcuts() {
  const context = useContext(KeyboardShortcutContext)
  if (!context) {
    throw new Error("useKeyboardShortcuts must be used within KeyboardShortcutProvider")
  }
  return context
}

interface KeyboardShortcutProviderProps {
  children: React.ReactNode
  onNewSession?: () => void
  onClearTimeline?: () => void
  onCycleAgent?: () => void
}

export function KeyboardShortcutProvider({ children, onNewSession, onClearTimeline, onCycleAgent }: KeyboardShortcutProviderProps) {
  const { toggleTheme } = useTheme()
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const registryRef = useRef<Map<string, ShortcutHandler>>(new Map())
  const [, setVersion] = useState(0)

  const registerShortcut = useCallback((key: string, shortcut: ShortcutHandler) => {
    registryRef.current.set(key, shortcut)
    setVersion((v) => v + 1)
    return () => {
      registryRef.current.delete(key)
      setVersion((v) => v + 1)
    }
  }, [])

  const closeAllOverlays = useCallback(() => {
    setIsCommandPaletteOpen(false)
    // Dispatch a custom event so other components (like skill panel) can close themselves
    window.dispatchEvent(new CustomEvent("close-overlays"))
  }, [])

  // Register built-ins
  useEffect(() => {
    const unregisters: (() => void)[] = []

    unregisters.push(
      registerShortcut("meta+k", {
        label: "Open Command Palette",
        handler: () => setIsCommandPaletteOpen((prev) => !prev),
      })
    )

    unregisters.push(
      registerShortcut("meta+n", {
        label: "New Session",
        handler: () => {
          if (onNewSession) onNewSession()
        },
      })
    )

    unregisters.push(
      registerShortcut("meta+d", {
        label: "Toggle Dark Mode",
        handler: () => {
          toggleTheme()
        },
      })
    )

    unregisters.push(
      registerShortcut("meta+l", {
        label: "Clear Timeline Display",
        handler: () => {
          if (onClearTimeline) onClearTimeline()
        },
      })
    )

    unregisters.push(
      registerShortcut("shift+tab", {
        label: "Cycle Agent",
        handler: () => {
          if (onCycleAgent) onCycleAgent()
        },
      })
    )

    return () => {
      unregisters.forEach((unreg) => unreg())
    }
  }, [registerShortcut, onNewSession, toggleTheme, onClearTimeline, onCycleAgent])

  // Global keydown listener
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeEl = document.activeElement
      const isInputFocused =
        activeEl?.tagName === "INPUT" ||
        activeEl?.tagName === "TEXTAREA" ||
        (activeEl as HTMLElement)?.isContentEditable

      // Normalize modifier to meta (cmd/ctrl)
      const hasModifier = event.metaKey || event.ctrlKey
      
      // If user is typing in an input, ignore alpha keys without modifiers
      // Allow shift+tab through for agent cycling
      const isShiftTab = event.shiftKey && event.key === "Tab"
      if (isInputFocused && !hasModifier && event.key !== "Escape" && !isShiftTab) {
        return
      }

      const keys: string[] = []
      if (hasModifier) keys.push("meta")
      if (event.shiftKey) keys.push("shift")
      if (event.altKey) keys.push("alt")
      
      const rawKey = event.key.toLowerCase()
      // Exclude modifier keys themselves when pressed alone
      if (!["meta", "control", "shift", "alt"].includes(rawKey)) {
        keys.push(rawKey)
      }

      const keyCombo = keys.join("+")

      const shortcut = registryRef.current.get(keyCombo)
      if (shortcut) {
        if (!shortcut.when || shortcut.when()) {
          event.preventDefault()
          event.stopPropagation()
          shortcut.handler()
          return
        }
      }

      // Built-in escape fallback
      if (event.key === "Escape") {
        closeAllOverlays()
      }
    }

    // Use capture phase to ensure we run before React handlers if necessary
    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [closeAllOverlays])

  const contextValue: KeyboardShortcutContextValue = {
    registerShortcut,
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    registry: registryRef.current,
    closeAllOverlays,
  }

  return (
    <KeyboardShortcutContext.Provider value={contextValue}>
      {children}
    </KeyboardShortcutContext.Provider>
  )
}
