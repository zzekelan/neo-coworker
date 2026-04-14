import type { ModelObserverPort } from "../application/ports/model-observer"
import { FailoverReason } from "../domain/error-classification"

export enum PoolStrategy {
  fill_first = "fill_first",
  round_robin = "round_robin",
  least_used = "least_used",
}

export type Credential = {
  key: string
  cooldownUntil?: Date
  usageCount: number
  lastError?: FailoverReason
}

export type CredentialPoolTelemetryContext = {
  sessionId?: string
  runId?: string
  turnKey?: string
}

export type CredentialPoolOptions = {
  now?: () => Date
  observer?: ModelObserverPort
  telemetry?: CredentialPoolTelemetryContext
}

type StoredCredential = Credential & {
  index: number
}

type PendingRotation = {
  failedKey: string
  reason: FailoverReason
}

export class CredentialPool {
  private readonly credentials: StoredCredential[]
  private readonly strategy: PoolStrategy
  private readonly now: () => Date
  private readonly observer?: ModelObserverPort
  private readonly telemetry?: CredentialPoolTelemetryContext
  private cursor = 0
  private pendingRotation: PendingRotation | null = null

  constructor(
    keys: string[],
    strategy: PoolStrategy = PoolStrategy.fill_first,
    options: CredentialPoolOptions = {},
  ) {
    this.credentials = normalizeKeys(keys).map((key, index) => ({
      key,
      index,
      usageCount: 0,
    }))
    this.strategy = strategy
    this.now = options.now ?? (() => new Date())
    this.observer = options.observer
    this.telemetry = options.telemetry
  }

  next(): Credential | null {
    const selected = this.selectCredential()
    this.emitRotation(selected)

    return cloneCredential(selected)
  }

  markFailed(key: string, reason: FailoverReason, cooldownMs: number) {
    const credential = this.credentials.find((item) => item.key === key)
    if (!credential) {
      return
    }

    const now = this.now().getTime()
    const clampedCooldownMs = Math.max(0, cooldownMs)

    credential.lastError = reason
    credential.cooldownUntil = clampedCooldownMs > 0
      ? new Date(now + clampedCooldownMs)
      : undefined
    this.pendingRotation = {
      failedKey: key,
      reason,
    }
  }

  markSuccess(key: string) {
    const credential = this.credentials.find((item) => item.key === key)
    if (!credential) {
      return
    }

    credential.usageCount += 1
    credential.cooldownUntil = undefined
    credential.lastError = undefined

    if (this.pendingRotation?.failedKey === key) {
      this.pendingRotation = null
    }
  }

  available() {
    const now = this.now().getTime()
    return this.credentials.filter((credential) => isCredentialAvailable(credential, now)).length
  }

  private selectCredential() {
    const now = this.now().getTime()

    switch (this.strategy) {
      case PoolStrategy.round_robin:
        return this.selectRoundRobin(now)
      case PoolStrategy.least_used:
        return this.selectLeastUsed(now)
      case PoolStrategy.fill_first:
      default:
        return this.credentials.find((credential) => isCredentialAvailable(credential, now)) ?? null
    }
  }

  private selectRoundRobin(now: number) {
    if (this.credentials.length === 0) {
      return null
    }

    for (let offset = 0; offset < this.credentials.length; offset += 1) {
      const index = (this.cursor + offset) % this.credentials.length
      const credential = this.credentials[index]
      if (!credential || !isCredentialAvailable(credential, now)) {
        continue
      }

      this.cursor = (index + 1) % this.credentials.length
      return credential
    }

    return null
  }

  private selectLeastUsed(now: number) {
    const availableCredentials = this.credentials.filter((credential) => isCredentialAvailable(credential, now))
    if (availableCredentials.length === 0) {
      return null
    }

    const leastUsageCount = Math.min(...availableCredentials.map((credential) => credential.usageCount))

    for (let offset = 0; offset < this.credentials.length; offset += 1) {
      const index = (this.cursor + offset) % this.credentials.length
      const credential = this.credentials[index]

      if (
        !credential
        || !isCredentialAvailable(credential, now)
        || credential.usageCount !== leastUsageCount
      ) {
        continue
      }

      this.cursor = (index + 1) % this.credentials.length
      return credential
    }

    return availableCredentials
      .sort((left, right) => left.index - right.index)[0] ?? null
  }

  private emitRotation(nextCredential: StoredCredential | null) {
    if (!this.pendingRotation) {
      return
    }

    const pendingRotation = this.pendingRotation
    this.pendingRotation = null

    if (nextCredential && nextCredential.key === pendingRotation.failedKey) {
      return
    }

    if (!this.telemetry?.sessionId || !this.telemetry.runId) {
      return
    }

    try {
      this.observer?.recordModelEvent?.({
        type: "credential.rotated",
        sessionId: this.telemetry.sessionId,
        runId: this.telemetry.runId,
        turnKey: this.telemetry.turnKey,
        failedKey: pendingRotation.failedKey,
        nextKey: nextCredential?.key ?? null,
        reason: pendingRotation.reason,
        remainingCredentials: this.available(),
      })
    } catch {}
  }
}

function normalizeKeys(keys: string[]) {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const key of keys) {
    const trimmed = key.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

function isCredentialAvailable(credential: Credential, now: number) {
  return credential.cooldownUntil == null || credential.cooldownUntil.getTime() <= now
}

function cloneCredential(credential: Credential | null): Credential | null {
  if (!credential) {
    return null
  }

  return {
    key: credential.key,
    cooldownUntil: credential.cooldownUntil ? new Date(credential.cooldownUntil) : undefined,
    usageCount: credential.usageCount,
    lastError: credential.lastError,
  }
}
