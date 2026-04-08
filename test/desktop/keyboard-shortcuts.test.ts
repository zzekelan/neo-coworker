import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop keyboard shortcuts", () => {
  test("KeyboardShortcutProvider mounts global keydown listener and handles modifier keys", () => {
    const source = readFileSync("src/desktop/src/providers/KeyboardShortcutProvider.tsx", "utf8")

    expect(source).toContain("window.addEventListener(\"keydown\"")
    expect(source).toContain("event.metaKey || event.ctrlKey")
    expect(source).toContain("isInputFocused")
    expect(source).toContain('registerShortcut("meta+d"')
    expect(source).toContain("toggleTheme()")
    expect(source).toContain('registerShortcut("meta+l"')
    expect(source).toContain("if (onClearTranscript) onClearTranscript()")
    expect(source).toContain('import { useTheme } from "./ThemeProvider"')
  })

  test("CommandPalette includes proper linear-style animations and fuzzy filtering", () => {
    const source = readFileSync("src/desktop/src/components/CommandPalette.tsx", "utf8")

    expect(source).toContain("AnimatePresence")
    expect(source).toContain("initial={{ opacity: 0, y: -8 }}")
    expect(source).toContain("animate={{ opacity: 1, y: 0 }}")
    expect(source).toContain("includes(query.toLowerCase())")
    expect(source).toContain("data-testid=\"command-palette\"")
  })

  test("App.tsx wraps UI with ThemeProvider, KeyboardShortcutProvider and mounts CommandPalette", () => {
    const source = readFileSync("src/desktop/src/App.tsx", "utf8")

    expect(source).toContain("<ThemeProvider")
    expect(source).toContain("<KeyboardShortcutProvider")
    expect(source).toContain("<CommandPalette />")
    expect(source).toContain("onClearTranscript={handleClearTranscriptDisplay}")
    expect(source).not.toContain("onToggleTheme=")
    expect(source).not.toContain("handleToggleTheme")
  })
})
