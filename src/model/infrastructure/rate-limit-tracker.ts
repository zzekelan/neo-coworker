import type { ModelObserverPort } from "../application/ports/model-observer"

export type RateLimitWindow = {
  limit: number
  remaining: number
  reset: Date
}

export type RateLimitInfo = {
  rpm?: RateLimitWindow
  tpm?: RateLimitWindow
}

export type RateLimitTrackerOptions = {
  now?: () => Date
  observer?: ModelObserverPort
  telemetry?: {
    sessionId?: string
    runId?: string
    turnKey?: string
  }
}

const DURATION_SEGMENT_PATTERN = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs|sec|s|minutes?|mins|min|m|hours?|hrs|hr|h|days?|d)/gi

export class RateLimitTracker {
  private info: RateLimitInfo = {}
  private readonly now: () => Date
  private readonly observer?: ModelObserverPort
  private readonly telemetry?: RateLimitTrackerOptions["telemetry"]

  constructor(options: RateLimitTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.observer = options.observer
    this.telemetry = options.telemetry
  }

  update(headers: Record<string, string>) {
    const normalizedHeaders = normalizeHeaders(headers)
    const observedAt = this.now()
    const rpm = readRateLimitWindow(normalizedHeaders, "requests", observedAt)
    const tpm = readRateLimitWindow(normalizedHeaders, "tokens", observedAt)

    if (rpm) {
      this.info.rpm = rpm
    }

    if (tpm) {
      this.info.tpm = tpm
    }
  }

  get(): RateLimitInfo {
    return cloneRateLimitInfo(this.info)
  }

  isNearLimit(threshold = 0.1) {
    const resolvedThreshold = Number.isFinite(threshold)
      ? Math.max(0, threshold)
      : 0.1
    const nearLimit = [this.info.rpm, this.info.tpm].some(
      (window) => window != null && isWindowNearLimit(window, resolvedThreshold),
    )

    if (nearLimit) {
      this.emitNearThreshold(resolvedThreshold)
    }

    return nearLimit
  }

  format() {
    const sections = [
      this.info.rpm ? formatWindow("RPM", this.info.rpm) : null,
      this.info.tpm ? formatWindow("TPM", this.info.tpm) : null,
    ].filter((section): section is string => section !== null)

    return sections.length > 0 ? sections.join("; ") : "rate limits unavailable"
  }

  private emitNearThreshold(threshold: number) {
    if (!this.telemetry?.sessionId || !this.telemetry.runId) {
      return
    }

    try {
      this.observer?.recordModelEvent?.({
        type: "rate_limit.near_threshold",
        sessionId: this.telemetry.sessionId,
        runId: this.telemetry.runId,
        turnKey: this.telemetry.turnKey,
        rpm_remaining: this.info.rpm?.remaining,
        tpm_remaining: this.info.tpm?.remaining,
        threshold,
      })
    } catch {}
  }
}

function normalizeHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
}

function readRateLimitWindow(
  headers: Record<string, string>,
  scope: "requests" | "tokens",
  observedAt: Date,
) {
  const limit = parsePositiveInteger(headers[`x-ratelimit-limit-${scope}`])
  const remaining = parseNonNegativeInteger(headers[`x-ratelimit-remaining-${scope}`])
  const reset = parseResetTimestamp(headers[`x-ratelimit-reset-${scope}`], observedAt)

  if (limit == null || remaining == null || reset == null) {
    return undefined
  }

  return {
    limit,
    remaining,
    reset,
  } satisfies RateLimitWindow
}

function parsePositiveInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value.trim())) {
    return undefined
  }

  const parsed = Number.parseInt(value.trim(), 10)
  return parsed > 0 ? parsed : undefined
}

function parseNonNegativeInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value.trim())) {
    return undefined
  }

  return Number.parseInt(value.trim(), 10)
}

function parseResetTimestamp(value: string | undefined, observedAt: Date) {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  const durationMs = parseDurationMs(trimmed)
  if (durationMs != null) {
    return new Date(observedAt.getTime() + durationMs)
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numericValue = Number(trimmed)
    if (!Number.isFinite(numericValue)) {
      return undefined
    }

    if (numericValue >= 1_000_000_000_000) {
      return new Date(numericValue)
    }

    if (numericValue >= 1_000_000_000) {
      return new Date(numericValue * 1000)
    }

    return new Date(observedAt.getTime() + numericValue * 1000)
  }

  const parsedDate = Date.parse(trimmed)
  if (Number.isNaN(parsedDate)) {
    return undefined
  }

  return new Date(parsedDate)
}

function parseDurationMs(value: string) {
  let matched = false
  let totalMs = 0

  const leftover = value.replaceAll(DURATION_SEGMENT_PATTERN, (_segment, amount, unit) => {
    matched = true
    totalMs += convertDurationMs(Number(amount), String(unit).toLowerCase())
    return ""
  })

  if (!matched || leftover.replaceAll(/[\s,]/g, "").length > 0) {
    return undefined
  }

  return totalMs
}

function convertDurationMs(amount: number, unit: string) {
  if (unit === "ms" || unit.startsWith("millisecond")) {
    return amount
  }

  if (unit === "m" || unit === "min" || unit === "mins" || unit.startsWith("minute")) {
    return amount * 60_000
  }

  if (unit === "h" || unit === "hr" || unit === "hrs" || unit.startsWith("hour")) {
    return amount * 3_600_000
  }

  if (unit === "d" || unit.startsWith("day")) {
    return amount * 86_400_000
  }

  return amount * 1000
}

function isWindowNearLimit(window: RateLimitWindow, threshold: number) {
  if (threshold >= 1) {
    return window.remaining <= threshold
  }

  return window.limit > 0 && window.remaining / window.limit <= threshold
}

function formatWindow(label: string, window: RateLimitWindow) {
  return `${label}: ${window.remaining}/${window.limit} remaining (reset ${window.reset.toISOString()})`
}

function cloneRateLimitInfo(info: RateLimitInfo): RateLimitInfo {
  return {
    rpm: info.rpm ? cloneRateLimitWindow(info.rpm) : undefined,
    tpm: info.tpm ? cloneRateLimitWindow(info.tpm) : undefined,
  }
}

function cloneRateLimitWindow(window: RateLimitWindow): RateLimitWindow {
  return {
    limit: window.limit,
    remaining: window.remaining,
    reset: new Date(window.reset),
  }
}
