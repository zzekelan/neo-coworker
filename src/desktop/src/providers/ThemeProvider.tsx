import { createContext, useCallback, useContext, useEffect } from "react"
import type { DesktopTheme } from "../desktop-settings"

interface ThemeContextValue {
  theme: DesktopTheme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}

interface ThemeProviderProps {
  theme: DesktopTheme
  onThemeChange: (next: DesktopTheme) => void
  children: React.ReactNode
}

export function ThemeProvider({ theme, onThemeChange, children }: ThemeProviderProps) {
  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark")
      document.documentElement.classList.remove("light")
    } else {
      document.documentElement.classList.remove("dark")
      document.documentElement.classList.add("light")
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    onThemeChange(theme === "dark" ? "light" : "dark")
  }, [theme, onThemeChange])

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
