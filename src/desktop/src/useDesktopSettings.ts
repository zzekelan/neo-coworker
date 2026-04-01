import { useEffect, useRef, useState } from "react"
import { applyDesktopSettings, loadDesktopSettings, saveDesktopSettings } from "./api"
import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopServerMode,
  type DesktopSettings,
} from "./desktop-settings"

export function useDesktopSettings() {
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_DESKTOP_SETTINGS)
  const [serverMode, setServerMode] = useState<DesktopServerMode>("external")
  const [isApplying, setIsApplying] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const saveTokenRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    void loadDesktopSettings()
      .then((result) => {
        if (cancelled) {
          return
        }

        setSettings(result.settings)
        setServerMode(result.serverMode)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        setErrorMessage(toErrorMessage(error))
      })

    return () => {
      cancelled = true
    }
  }, [])

  return {
    settings,
    serverMode,
    isApplying,
    errorMessage,
    async updateSettings(patch: Partial<DesktopSettings>) {
      const nextSettings = {
        ...settings,
        ...patch,
      }
      setSettings(nextSettings)
      setErrorMessage(null)

      const currentToken = saveTokenRef.current + 1
      saveTokenRef.current = currentToken

      try {
        const saved = await saveDesktopSettings(nextSettings)
        if (saveTokenRef.current !== currentToken) {
          return
        }

        setSettings(saved.settings)
        setServerMode(saved.serverMode)
      } catch (error) {
        if (saveTokenRef.current !== currentToken) {
          return
        }

        setErrorMessage(toErrorMessage(error))
      }
    },
    async applySettings() {
      setIsApplying(true)
      setErrorMessage(null)

      try {
        const result = await applyDesktopSettings(settings)
        setSettings(result.settings)
        setServerMode(result.serverMode)
        return result.restarted
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
        return false
      } finally {
        setIsApplying(false)
      }
    },
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
