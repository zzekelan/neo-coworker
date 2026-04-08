import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop theme provider", () => {
  test("ThemeProvider exists as independent file with context, hook, and classList management", () => {
    const source = readFileSync("src/desktop/src/providers/ThemeProvider.tsx", "utf8")

    expect(source).toContain("export function useTheme()")
    expect(source).toContain("export function ThemeProvider")
    expect(source).toContain("createContext")
    expect(source).toContain('classList.add("dark")')
    expect(source).toContain('classList.remove("dark")')
    expect(source).toContain("toggleTheme")
    expect(source).toContain("onThemeChange")
  })

  test("App.tsx no longer contains inline theme state or toggle logic", () => {
    const source = readFileSync("src/desktop/src/App.tsx", "utf8")

    expect(source).not.toContain("document.documentElement.dataset.theme")
    expect(source).not.toContain("handleToggleTheme")
    expect(source).not.toContain("onToggleTheme={")
    expect(source).toContain("<ThemeProvider")
    expect(source).toContain("</ThemeProvider>")
  })

  test("KeyboardShortcutProvider uses useTheme() instead of onToggleTheme prop", () => {
    const source = readFileSync("src/desktop/src/providers/KeyboardShortcutProvider.tsx", "utf8")

    expect(source).toContain('import { useTheme } from "./ThemeProvider"')
    expect(source).toContain("const { toggleTheme } = useTheme()")
    expect(source).not.toContain("onToggleTheme")
  })

  test("CSS uses .dark class model instead of data-theme attribute", () => {
    const css = readFileSync("src/desktop/src/index.css", "utf8")

    expect(css).toContain(":root:not(.dark)")
    expect(css).not.toContain('[data-theme="light"]')
    expect(css).toContain("--color-paper")
    expect(css).toContain("--color-ink")
    expect(css).toContain("--color-surface")
    expect(css).toContain("--color-border")
    expect(css).toContain("--color-accent")
    expect(css).toContain("--color-muted")
    expect(css).toContain("--color-highlight")
    expect(css).toContain("--color-danger")
    expect(css).toContain("--color-success")
  })

  test("index.html defaults to dark class for FOUC prevention", () => {
    const html = readFileSync("src/desktop/index.html", "utf8")

    expect(html).toContain('class="dark"')
  })

  test("ChatArea header contains theme toggle button with Sun/Moon icons", () => {
    const source = readFileSync("src/desktop/src/components/ChatArea.tsx", "utf8")

    expect(source).toContain("ThemeToggleButton")
    expect(source).toContain("useTheme")
    expect(source).toContain("<Sun")
    expect(source).toContain("<Moon")
    expect(source).toContain("aria-label")
  })

  test("no hardcoded colors remain outside index.css theme tokens (except black/white)", () => {
    const themeProvider = readFileSync("src/desktop/src/providers/ThemeProvider.tsx", "utf8")

    expect(themeProvider).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(themeProvider).not.toMatch(/rgb\(/)
    expect(themeProvider).not.toMatch(/rgba\(/)
  })

  test("theme toggle persists via saveDesktopSettings, not draft-only updateSettings", () => {
    const settings = readFileSync("src/desktop/src/useDesktopSettings.ts", "utf8")

    expect(settings).toContain("async persistTheme")
    expect(settings).toContain("saveDesktopSettings(nextSettings)")
    expect(settings).toContain("setAppliedSettings(result.settings)")

    const app = readFileSync("src/desktop/src/App.tsx", "utf8")

    expect(app).toContain("persistTheme")
    expect(app).not.toMatch(/onThemeChange.*updateSettings\(\s*\{\s*theme/)
  })

  test("persistTheme handles errors without crashing", () => {
    const settings = readFileSync("src/desktop/src/useDesktopSettings.ts", "utf8")

    const persistBlock = settings.slice(
      settings.indexOf("async persistTheme"),
      settings.indexOf("async applyGeneralSettings"),
    )
    expect(persistBlock).toContain("try {")
    expect(persistBlock).toContain("catch (error)")
    expect(persistBlock).toContain("setErrorMessage")
  })
})
