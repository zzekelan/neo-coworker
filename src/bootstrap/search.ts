import {
  createHttpSearchToolBackend,
  type HttpSearchToolBackendConfig,
  type SearchToolBackend,
} from "../tool"

export type SearchBackendConfig = HttpSearchToolBackendConfig

export type DefaultSearchBackendInput = {
  env?: Record<string, string | undefined>
}

export function resolveSearchBackendConfig(
  env: Record<string, string | undefined> = process.env,
): SearchBackendConfig | undefined {
  const urlValue = readEnvValue(env, "SEARCH_BACKEND_URL")
  if (!urlValue) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    throw new Error("SEARCH_BACKEND_URL must be a valid absolute URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SEARCH_BACKEND_URL must use http or https")
  }

  return {
    url: url.toString(),
    bearerToken: readEnvValue(env, "SEARCH_BACKEND_BEARER_TOKEN"),
  }
}

export function createDefaultSearchBackend(
  input: DefaultSearchBackendInput = {},
): SearchToolBackend | undefined {
  const config = resolveSearchBackendConfig(input.env)
  if (!config) {
    return undefined
  }

  return createHttpSearchToolBackend(config)
}

function readEnvValue(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  return value ? value : undefined
}
