const LOOPBACK_NO_PROXY_ENTRIES = ["127.0.0.1", "localhost"]

export function buildLoopbackEnv(overrides = {}, baseEnv = process.env) {
  const env = {}

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value != null) {
      env[key] = String(value)
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value != null) {
      env[key] = String(value)
    }
  }

  env.NO_PROXY = appendNoProxyEntries(env.NO_PROXY, LOOPBACK_NO_PROXY_ENTRIES)
  env.no_proxy = appendNoProxyEntries(env.no_proxy, LOOPBACK_NO_PROXY_ENTRIES)

  return env
}

function appendNoProxyEntries(value, requiredEntries) {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  const seenEntries = new Set(entries.map((entry) => entry.toLowerCase()))

  for (const entry of requiredEntries) {
    if (!seenEntries.has(entry.toLowerCase())) {
      entries.push(entry)
    }
  }

  return entries.join(",")
}
