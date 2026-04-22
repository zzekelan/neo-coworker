import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { readEnvWithFallback } from "./env"
import { getServerStoragePath } from "./paths"
import type { ModelsDevCatalog } from "./provider-capabilities"
import { MODELS_DEV_CAPABILITY_SNAPSHOT } from "./provider-capabilities-snapshot"

const MODELS_DEV_API_URL = "https://models.dev/api.json"
const DEFAULT_MODELS_DEV_REFRESH_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_MODELS_DEV_FETCH_TIMEOUT_MS = 10_000

export type ModelsDevCatalogCacheSource =
  | "memory"
  | "disk"
  | "remote"
  | "bundled-snapshot"

export type LoadModelsDevCatalogInput = {
  env?: Record<string, string | undefined>
  cwd?: string
  fetchImpl?: typeof fetch
  now?: () => number
  cachePath?: string
  refreshIntervalMs?: number
  fetchTimeoutMs?: number
  snapshot?: ModelsDevCatalog
}

export type LoadedModelsDevCatalog = {
  catalog: ModelsDevCatalog
  source: ModelsDevCatalogCacheSource
  cachePath: string
  stale: boolean
  fetchAttempted: boolean
  diskCacheCorrupted: boolean
}

type CachedModelsDevCatalog = {
  catalog: ModelsDevCatalog
  loadedAt: number
}

const modelsDevCatalogMemoryCache = new Map<string, CachedModelsDevCatalog>()

export function getModelsDevCatalogCachePath(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
) {
  const serverStoragePath =
    readEnvWithFallback(env, "NCOWORKER_SERVER_DB_PATH", "AGENT_SERVER_DB_PATH") ??
    getServerStoragePath(cwd)

  return join(dirname(serverStoragePath), "models.dev.json")
}

export async function loadModelsDevCatalog(
  input: LoadModelsDevCatalogInput = {},
): Promise<LoadedModelsDevCatalog> {
  const now = input.now ?? Date.now
  const refreshIntervalMs = input.refreshIntervalMs ?? DEFAULT_MODELS_DEV_REFRESH_INTERVAL_MS
  const snapshot = input.snapshot ?? MODELS_DEV_CAPABILITY_SNAPSHOT
  const cachePath = input.cachePath ?? getModelsDevCatalogCachePath(input.env, input.cwd)

  const cached = modelsDevCatalogMemoryCache.get(cachePath)
  if (cached) {
    if (isFresh(cached.loadedAt, now(), refreshIntervalMs)) {
      return {
        catalog: cached.catalog,
        source: "memory",
        cachePath,
        stale: false,
        fetchAttempted: false,
        diskCacheCorrupted: false,
      }
    }

    const refreshed = await fetchAndPersistModelsDevCatalog({
      cachePath,
      fetchImpl: input.fetchImpl ?? fetch,
      fetchTimeoutMs: input.fetchTimeoutMs ?? DEFAULT_MODELS_DEV_FETCH_TIMEOUT_MS,
      now,
    })
    if (refreshed) {
      return refreshed
    }

    return {
      catalog: cached.catalog,
      source: "memory",
      cachePath,
      stale: true,
      fetchAttempted: true,
      diskCacheCorrupted: false,
    }
  }

  const diskCache = await readDiskCache(cachePath)
  if (diskCache.catalog) {
    if (isFresh(diskCache.loadedAt, now(), refreshIntervalMs)) {
      setMemoryCache(cachePath, diskCache.catalog, diskCache.loadedAt)
      return {
        catalog: diskCache.catalog,
        source: "disk",
        cachePath,
        stale: false,
        fetchAttempted: false,
        diskCacheCorrupted: false,
      }
    }

    const refreshed = await fetchAndPersistModelsDevCatalog({
      cachePath,
      fetchImpl: input.fetchImpl ?? fetch,
      fetchTimeoutMs: input.fetchTimeoutMs ?? DEFAULT_MODELS_DEV_FETCH_TIMEOUT_MS,
      now,
    })
    if (refreshed) {
      return refreshed
    }

    setMemoryCache(cachePath, diskCache.catalog, diskCache.loadedAt)
    return {
      catalog: diskCache.catalog,
      source: "disk",
      cachePath,
      stale: true,
      fetchAttempted: true,
      diskCacheCorrupted: diskCache.corrupted,
    }
  }

  const refreshed = await fetchAndPersistModelsDevCatalog({
    cachePath,
    fetchImpl: input.fetchImpl ?? fetch,
    fetchTimeoutMs: input.fetchTimeoutMs ?? DEFAULT_MODELS_DEV_FETCH_TIMEOUT_MS,
    now,
  })
  if (refreshed) {
    return refreshed
  }

  setMemoryCache(cachePath, snapshot, now())
  return {
    catalog: snapshot,
    source: "bundled-snapshot",
    cachePath,
    stale: false,
    fetchAttempted: true,
    diskCacheCorrupted: diskCache.corrupted,
  }
}

export function _resetModelsDevCatalogCache() {
  modelsDevCatalogMemoryCache.clear()
}

function isFresh(loadedAt: number, currentTime: number, refreshIntervalMs: number) {
  return currentTime - loadedAt < refreshIntervalMs
}

function setMemoryCache(cachePath: string, catalog: ModelsDevCatalog, loadedAt: number) {
  modelsDevCatalogMemoryCache.set(cachePath, {
    catalog,
    loadedAt,
  })
}

async function fetchAndPersistModelsDevCatalog(input: {
  cachePath: string
  fetchImpl: typeof fetch
  fetchTimeoutMs: number
  now: () => number
}): Promise<LoadedModelsDevCatalog | null> {
  try {
    const response = await input.fetchImpl(MODELS_DEV_API_URL, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(input.fetchTimeoutMs),
    })

    if (!response.ok) {
      return null
    }

    const payloadText = await response.text()
    const catalog = parseModelsDevCatalog(payloadText)
    await mkdir(dirname(input.cachePath), { recursive: true })
    await writeFile(input.cachePath, JSON.stringify(catalog, null, 2), "utf8")
    setMemoryCache(input.cachePath, catalog, input.now())

    return {
      catalog,
      source: "remote",
      cachePath: input.cachePath,
      stale: false,
      fetchAttempted: true,
      diskCacheCorrupted: false,
    }
  } catch {
    return null
  }
}

async function readDiskCache(cachePath: string) {
  try {
    const [payloadText, cacheInfo] = await Promise.all([
      readFile(cachePath, "utf8"),
      stat(cachePath),
    ])

    return {
      catalog: parseModelsDevCatalog(payloadText),
      loadedAt: cacheInfo.mtimeMs,
      corrupted: false,
    }
  } catch (error) {
    if (isMissingCacheError(error)) {
      return {
        catalog: null,
        loadedAt: 0,
        corrupted: false,
      }
    }

    return {
      catalog: null,
      loadedAt: 0,
      corrupted: true,
    }
  }
}

function isMissingCacheError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function parseModelsDevCatalog(payloadText: string): ModelsDevCatalog {
  const parsed = JSON.parse(payloadText) as unknown
  return validateModelsDevCatalog(parsed)
}

function validateModelsDevCatalog(value: unknown): ModelsDevCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("models.dev catalog must be an object")
  }

  for (const providerValue of Object.values(value)) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) {
      throw new Error("models.dev provider entry must be an object")
    }

    const provider = providerValue as Record<string, unknown>
    if (typeof provider.id !== "string" || typeof provider.name !== "string") {
      throw new Error("models.dev provider entry is missing id/name")
    }

    if (!provider.models || typeof provider.models !== "object" || Array.isArray(provider.models)) {
      throw new Error("models.dev provider entry is missing models")
    }
  }

  return value as ModelsDevCatalog
}
