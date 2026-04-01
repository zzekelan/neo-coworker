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
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
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

  useEffect(() => {
    if (!successMessage) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSuccessMessage(null)
    }, 2200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [successMessage])

  return {
    settings,
    serverMode,
    isApplying,
    errorMessage,
    successMessage,
    async updateSettings(patch: Partial<DesktopSettings>) {
      const nextSettings = {
        ...settings,
        ...patch,
      }
      setSettings(nextSettings)
      setErrorMessage(null)
      setSuccessMessage(null)

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
      setSuccessMessage(null)

      try {
        const result = await applyDesktopSettings(settings)
        setSettings(result.settings)
        setServerMode(result.serverMode)
        setSuccessMessage("applied")
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
