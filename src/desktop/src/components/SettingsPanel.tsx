import type { ReactNode } from "react"
import type { DesktopServerMode, DesktopSettings } from "../desktop-settings"
import { cn } from "../lib/utils"
import { useDesktopText } from "../i18n"

interface SettingsPanelProps {
  isOpen: boolean
  settings: DesktopSettings
  serverMode: DesktopServerMode
  isApplying: boolean
  hasBusySession: boolean
  errorMessage: string | null
  onClose(): void
  onUpdateSettings(patch: Partial<DesktopSettings>): void | Promise<unknown>
  onApplySettings(): void | Promise<unknown>
}

export function SettingsPanel({
  isOpen,
  settings,
  serverMode,
  isApplying,
  hasBusySession,
  errorMessage,
  onClose,
  onUpdateSettings,
  onApplySettings,
}: SettingsPanelProps) {
  const text = useDesktopText()
  const llmFieldsDisabled = serverMode !== "managed-local"
  const applyDisabled = llmFieldsDisabled || isApplying || hasBusySession

  if (!isOpen) {
    return null
  }

  return (
    <div className="absolute inset-x-3 bottom-14 z-30 rounded-[1.4rem] border border-zinc-200 bg-white/98 p-4 shadow-[0_22px_54px_rgba(24,24,27,0.16)] backdrop-blur-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-zinc-900">{text.settings.title}</h3>
          <p className="mt-1 text-xs text-zinc-500">.agents/desktop-settings.json</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100"
        >
          Close
        </button>
      </div>

      <div className="space-y-3">
        <Field label={text.settings.language}>
          <select
            value={settings.language}
            onChange={(event) => void onUpdateSettings({ language: event.target.value as DesktopSettings["language"] })}
            className="h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-800 outline-none transition-colors focus:border-zinc-300"
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </Field>

        <Field label={text.settings.provider}>
          <select
            value={settings.provider}
            disabled={llmFieldsDisabled}
            onChange={(event) =>
              void onUpdateSettings({
                provider: event.target.value as DesktopSettings["provider"],
              })
            }
            className={fieldClassName(llmFieldsDisabled)}
          >
            <option value="openai">openai</option>
            <option value="openai-compatible">openai-compatible</option>
          </select>
        </Field>

        <Field label={text.settings.apiKey}>
          <input
            type="password"
            value={settings.apiKey}
            disabled={llmFieldsDisabled}
            onChange={(event) => void onUpdateSettings({ apiKey: event.target.value })}
            className={fieldClassName(llmFieldsDisabled)}
          />
        </Field>

        <Field label={text.settings.model}>
          <input
            value={settings.model}
            disabled={llmFieldsDisabled}
            onChange={(event) => void onUpdateSettings({ model: event.target.value })}
            className={fieldClassName(llmFieldsDisabled)}
          />
        </Field>

        <Field label={text.settings.baseUrl}>
          <input
            value={settings.baseURL}
            disabled={llmFieldsDisabled}
            onChange={(event) => void onUpdateSettings({ baseURL: event.target.value })}
            className={fieldClassName(llmFieldsDisabled)}
          />
        </Field>

        <Field label={text.settings.timeout}>
          <input
            value={settings.timeoutMs}
            disabled={llmFieldsDisabled}
            onChange={(event) =>
              void onUpdateSettings({
                timeoutMs: event.target.value.replace(/[^\d]/g, ""),
              })
            }
            className={fieldClassName(llmFieldsDisabled)}
          />
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{text.settings.timeoutHint}</p>
        </Field>
      </div>

      {serverMode !== "managed-local" ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
          {text.settings.externalHint}
        </p>
      ) : null}

      {hasBusySession ? (
        <p className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-700">
          {text.settings.stopRunsFirst}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={applyDisabled}
          onClick={() => void onApplySettings()}
          className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isApplying ? text.settings.applying : text.settings.apply}
        </button>
      </div>
    </div>
  )
}

function Field(input: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold tracking-[0.12em] text-zinc-400 uppercase">
        {input.label}
      </span>
      {input.children}
    </label>
  )
}

function fieldClassName(disabled: boolean) {
  return cn(
    "h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-800 outline-none transition-colors focus:border-zinc-300",
    disabled && "cursor-not-allowed bg-zinc-100 text-zinc-400",
  )
}
