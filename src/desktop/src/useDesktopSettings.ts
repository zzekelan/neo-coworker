import { useEffect, useRef, useState } from "react"
import { applyDesktopSettings, loadDesktopSettings, saveDesktopSettings } from "./api"
import {
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopServerMode,
  type DesktopSettings,
  type DesktopTheme,
} from "./desktop-settings"

export type DesktopSettingsSuccessMessage = "general-applied" | "llm-applied"

export function useDesktopSettings() {
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_DESKTOP_SETTINGS)
  const [appliedSettings, setAppliedSettings] = useState<DesktopSettings>(DEFAULT_DESKTOP_SETTINGS)
  const [serverMode, setServerMode] = useState<DesktopServerMode>("external")
  const [isApplying, setIsApplying] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<DesktopSettingsSuccessMessage | null>(null)
  const loadTokenRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    void loadDesktopSettings()
      .then((result) => {
        if (cancelled) {
          return
        }

        setSettings(result.settings)
        setAppliedSettings(result.settings)
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
    appliedSettings,
    serverMode,
    isApplying,
    errorMessage,
    successMessage,
    updateSettings(patch: Partial<DesktopSettings>) {
      const nextSettings = {
        ...settings,
        ...patch,
      }
      setSettings(nextSettings)
      setErrorMessage(null)
      setSuccessMessage(null)
    },
    async persistTheme(next: DesktopTheme) {
      const nextSettings = { ...settings, theme: next }
      setSettings(nextSettings)
      setErrorMessage(null)

      try {
        const result = await saveDesktopSettings(nextSettings)
        setSettings(result.settings)
        setAppliedSettings(result.settings)
        setServerMode(result.serverMode)
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
      }
    },
    async applyGeneralSettings() {
      setIsApplying(true)
      setErrorMessage(null)
      setSuccessMessage(null)

      try {
        const currentToken = loadTokenRef.current + 1
        loadTokenRef.current = currentToken
        const result = await saveDesktopSettings(settings)
        if (loadTokenRef.current !== currentToken) {
          return false
        }

        setSettings(result.settings)
        setAppliedSettings(result.settings)
        setServerMode(result.serverMode)
        setSuccessMessage("general-applied")
        return false
      } catch (error) {
        setErrorMessage(toErrorMessage(error))
        return false
      } finally {
        setIsApplying(false)
      }
    },
    async applyLlmSettings() {
      setIsApplying(true)
      setErrorMessage(null)
      setSuccessMessage(null)

      try {
        const result = await applyDesktopSettings(settings)
        setSettings(result.settings)
        setAppliedSettings({
          ...result.settings,
          language: appliedSettings.language,
        })
        setServerMode(result.serverMode)
        setSuccessMessage("llm-applied")
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
