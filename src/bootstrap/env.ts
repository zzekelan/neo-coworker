/**
 * Read an environment variable, preferring `newKey` with `legacyKey` as fallback.
 * Enables backward-compatible renaming of environment variables.
 */
export function readEnvWithFallback(
  env: Record<string, string | undefined>,
  newKey: string,
  legacyKey: string,
): string | undefined {
  return env[newKey] ?? env[legacyKey]
}
