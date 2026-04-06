import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import type { DesktopServerMode, DesktopSettings } from "../desktop-settings"
import { cn } from "../lib/utils"
import { useDesktopText } from "../i18n"
import type { DesktopSettingsSuccessMessage } from "../useDesktopSettings"

type SettingsSectionId = "general" | "llm"
type SelectOption<T extends string> = {
  value: T
  label: string
}

interface SettingsPanelProps {
  isOpen: boolean
  settings: DesktopSettings
  serverMode: DesktopServerMode
  isApplying: boolean
  hasBusySession: boolean
  errorMessage: string | null
  successMessage: DesktopSettingsSuccessMessage | null
  onClose(): void
  onUpdateSettings(patch: Partial<DesktopSettings>): void | Promise<unknown>
  onApplyGeneralSettings(): void | Promise<unknown>
  onApplyLlmSettings(): void | Promise<unknown>
}

export function SettingsPanel({
  isOpen,
  settings,
  serverMode,
  isApplying,
  hasBusySession,
  errorMessage,
  successMessage,
  onClose,
  onUpdateSettings,
  onApplyGeneralSettings,
  onApplyLlmSettings,
}: SettingsPanelProps) {
  const text = useDesktopText()
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general")
  const llmFieldsDisabled = serverMode !== "managed-local"
  const isGeneralSection = activeSection === "general"
  const applyDisabled = isGeneralSection
    ? isApplying
    : llmFieldsDisabled || isApplying || hasBusySession
  const sections = useMemo(
    () =>
      [
        {
          id: "general",
          label: text.settings.general,
          description: text.settings.language,
        },
        {
          id: "llm",
          label: text.settings.llm,
          description: `${text.settings.provider} / ${text.settings.model}`,
        },
      ] satisfies Array<{ id: SettingsSectionId; label: string; description: string }>,
    [text],
  )

  useEffect(() => {
    if (!isOpen) {
      setActiveSection("general")
    }
  }, [isOpen])

  return (
    <div
      aria-hidden={!isOpen}
      className={cn(
        "absolute bottom-14 left-0 z-30 h-[36rem] w-[min(38rem,calc(100vw-2rem))] origin-bottom-left overflow-hidden rounded-[1.55rem] border border-border bg-paper shadow-[0_24px_60px_rgba(24,24,27,0.18)] backdrop-blur-xl transition-all duration-200 ease-out",
        isOpen
          ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
          : "pointer-events-none translate-y-3 scale-[0.985] opacity-0",
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink">{text.settings.title}</h3>
          <p className="mt-1 text-[11px] tracking-[0.08em] text-muted uppercase">{text.settings.storagePath}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-border bg-paper px-3 py-1.5 text-[11px] font-medium tracking-[0.08em] text-muted uppercase transition-colors hover:bg-surface"
        >
          {text.settings.close}
        </button>
      </div>

      <div className="grid h-[calc(36rem-4.625rem)] grid-cols-[12rem_minmax(0,1fr)]">
        <aside className="overflow-y-auto [scrollbar-gutter:stable] border-r border-border bg-paper p-3">
          <div className="space-y-1">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "w-full rounded-2xl border px-3 py-3 text-left transition-all",
                  activeSection === section.id
                    ? "border-border bg-paper text-ink shadow-[0_10px_24px_rgba(24,24,27,0.08)]"
                    : "border-transparent text-muted hover:border-border hover:bg-paper hover:text-ink",
                )}
              >
                <div className="text-sm font-semibold tracking-tight">{section.label}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-accent">{section.description}</p>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-h-0 h-full flex-col p-5">
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] pr-2">
            {activeSection === "general" ? (
              <section className="space-y-4">
                <SectionHeading title={text.settings.general} />
                <Field label={text.settings.language}>
                  <SettingsSelect
                    value={settings.language}
                    onChange={(value) => void onUpdateSettings({ language: value })}
                    options={[
                      { value: "en", label: "English" },
                      { value: "zh", label: "中文" },
                    ]}
                  />
                </Field>
              </section>
            ) : (
              <section className="space-y-4">
                <SectionHeading title={text.settings.llm} />
                <div className="grid gap-3">
                  <Field label={text.settings.provider}>
                    <SettingsSelect
                      value={settings.provider}
                      disabled={llmFieldsDisabled}
                      onChange={(value) =>
                        void onUpdateSettings({
                          provider: value,
                        })
                      }
                      options={[
                        { value: "", label: text.settings.providerUnset },
                        { value: "openai", label: "openai" },
                        { value: "openai-compatible", label: "openai-compatible" },
                      ]}
                    />
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
                    <p className="mt-1 text-[11px] leading-relaxed text-accent">{text.settings.timeoutHint}</p>
                  </Field>
                </div>
              </section>
            )}

            <div className="mt-5 space-y-3">
              {activeSection === "llm" && serverMode !== "managed-local" ? (
                <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-500">
                  {text.settings.externalHint}
                </p>
              ) : null}

              {activeSection === "llm" && hasBusySession ? (
                <p className="rounded-2xl border border-highlight/30 bg-highlight/10 px-3 py-2.5 text-xs leading-relaxed text-highlight">
                  {text.settings.stopRunsFirst}
                </p>
              ) : null}

              {errorMessage ? (
                <p className="rounded-2xl border border-danger bg-danger/10 px-3 py-2.5 text-xs leading-relaxed text-danger">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex shrink-0 justify-end border-t border-border pt-4">
            <button
              type="button"
              disabled={applyDisabled}
              onClick={() =>
                void (isGeneralSection ? onApplyGeneralSettings() : onApplyLlmSettings())
              }
              className="rounded-2xl bg-ink px-4 py-2.5 text-sm font-medium text-ink shadow-[0_12px_24px_rgba(24,24,27,0.18)] transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isApplying
                ? text.settings.applying
                : isGeneralSection
                  ? text.settings.applyGeneral
                  : text.settings.applyLlm}
            </button>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "pointer-events-none absolute bottom-20 left-1/2 z-10 w-[calc(100%-11rem)] max-w-sm -translate-x-1/2 transition-all duration-200 ease-out",
          successMessage ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        )}
      >
        <div className="rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-center text-sm leading-relaxed text-success shadow-[0_16px_30px_rgba(34,197,94,0.12)] backdrop-blur-sm">
          {successMessage === "general-applied"
            ? text.settings.appliedGeneral
            : text.settings.appliedLlm}
        </div>
      </div>
    </div>
  )
}

function SectionHeading(input: {
  title: string
  subtitle?: string
}) {
  return (
    <div className="mb-1">
      <h4 className="text-base font-semibold tracking-tight text-ink">{input.title}</h4>
      {input.subtitle ? <p className="mt-1 text-xs leading-relaxed text-muted">{input.subtitle}</p> : null}
    </div>
  )
}

function Field(input: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">
        {input.label}
      </span>
      {input.children}
    </label>
  )
}

function fieldClassName(disabled: boolean) {
  return cn(
    "h-11 w-full rounded-2xl border border-border bg-paper px-3.5 text-sm text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] outline-none transition-colors focus:border-border focus:ring-2 focus:ring-border",
    disabled && "cursor-not-allowed bg-surface text-accent shadow-none",
  )
}

function SettingsSelect<T extends string>(input: {
  value: T
  options: Array<SelectOption<T>>
  disabled?: boolean
  onChange(value: T): void | Promise<unknown>
}) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const selectedOption =
    input.options.find((option) => option.value === input.value) ?? input.options[0] ?? null

  useEffect(() => {
    if (!isOpen) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false)
      }
    }

    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={input.disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          if (!input.disabled) {
            setIsOpen((previous) => !previous)
          }
        }}
        className={cn(
          fieldClassName(Boolean(input.disabled)),
          "flex items-center justify-between text-left",
          isOpen && "border-border ring-2 ring-border",
        )}
      >
        <span className="truncate">{selectedOption?.label ?? ""}</span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-accent transition-transform", isOpen && "rotate-180")} />
      </button>

      <div
        className={cn(
          "absolute top-[calc(100%+0.5rem)] left-0 right-0 z-20 origin-top overflow-hidden rounded-2xl border border-border bg-paper p-1.5 shadow-[0_16px_36px_rgba(24,24,27,0.12)] backdrop-blur-sm transition-all duration-150",
          isOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        )}
      >
        <div role="listbox" className="space-y-1">
          {input.options.map((option) => {
            const isSelected = option.value === input.value

            return (
              <button
                key={option.value || "__empty"}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  setIsOpen(false)
                  void input.onChange(option.value)
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                  isSelected
                    ? "bg-surface text-ink shadow-sm ring-1 ring-border"
                    : "text-ink hover:bg-surface",
                )}
              >
                <span className="truncate">{option.label}</span>
                <Check className={cn("h-4 w-4 shrink-0 text-muted", !isSelected && "opacity-0")} />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
