import OpenAI from "openai"
import { createAgentServerClient } from "./cli/server-client"
import { createStdioCliIo } from "./cli/io"
import { parseRunCommand, runCli } from "./cli/run-command"
import { createOpenAIProvider } from "./providers/openai"
import type { Provider } from "./providers/types"

type ProviderKind = "openai" | "openai-compatible"

type ProviderConfig = {
  provider: ProviderKind
  apiKey: string
  model: string
  baseURL?: string
  timeout?: number
}

type OpenAIClientConfig = Pick<ProviderConfig, "apiKey" | "baseURL" | "timeout">
type OpenAICompatibleProviderFactory = (input: {
  model: string
  client: OpenAI
}) => Provider
type DefaultProviderInput = {
  env?: Record<string, string | undefined>
  createClient?: (config: OpenAIClientConfig) => OpenAI
  createOpenAIProviderImpl?: typeof createOpenAIProvider
  createOpenAICompatibleProviderImpl?: OpenAICompatibleProviderFactory
}
type BuildCliInput = {
  provider?: Provider
  env?: Record<string, string | undefined>
  createClient?: (config: OpenAIClientConfig) => OpenAI
  createOpenAIProviderImpl?: typeof createOpenAIProvider
  createOpenAICompatibleProviderImpl?: OpenAICompatibleProviderFactory
  createAgentServerClientImpl?: typeof createAgentServerClient
  createIo?: typeof createStdioCliIo
  runCliImpl?: typeof runCli
}

function readEnvValue(
  env: Record<string, string | undefined>,
  ...keys: string[]
) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }

  return undefined
}

function parseProviderKind(value: string | undefined): ProviderKind {
  if (!value) {
    throw new Error("LLM_PROVIDER is required")
  }

  if (value !== "openai" && value !== "openai-compatible") {
    throw new Error("LLM_PROVIDER must be one of: openai, openai-compatible")
  }

  return value
}

function parseTimeout(value: string | undefined) {
  if (value == null) {
    return undefined
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("LLM_TIMEOUT_MS must be a valid integer when provided")
  }

  return Number.parseInt(value, 10)
}

export function resolveAgentServerOrigin(
  env: Record<string, string | undefined> = process.env,
) {
  const value = readEnvValue(env, "AGENT_SERVER_URL")
  if (!value) {
    return undefined
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("AGENT_SERVER_URL must be a valid absolute URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AGENT_SERVER_URL must use http or https")
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AGENT_SERVER_URL must not include a path, query, or hash")
  }

  return url.origin
}

export function resolveDefaultProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  const provider = parseProviderKind(readEnvValue(env, "LLM_PROVIDER"))
  const apiKey = readEnvValue(env, "LLM_API_KEY")

  if (!apiKey) {
    throw new Error("LLM_API_KEY is required to run the CLI without an injected provider")
  }

  const baseURL = readEnvValue(env, "LLM_BASE_URL")
  if (provider === "openai-compatible" && !baseURL) {
    throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible")
  }
  const model = readEnvValue(env, "LLM_MODEL")
  if (provider === "openai-compatible" && !model) {
    throw new Error("LLM_MODEL is required when LLM_PROVIDER=openai-compatible")
  }

  return {
    provider,
    apiKey,
    model: model ?? "gpt-5",
    baseURL,
    timeout: parseTimeout(readEnvValue(env, "LLM_TIMEOUT_MS")),
  }
}

async function loadOpenAICompatibleProviderFactory(): Promise<OpenAICompatibleProviderFactory> {
  const module = await import("./providers/openai-compatible")
  return module.createOpenAICompatibleProvider
}

export async function createDefaultProvider(input: DefaultProviderInput = {}): Promise<Provider> {
  const config = resolveDefaultProviderConfig(input.env)
  const createClient =
    input.createClient ??
    ((clientConfig: OpenAIClientConfig) =>
      new OpenAI({
        apiKey: clientConfig.apiKey,
        baseURL: clientConfig.baseURL,
        timeout: clientConfig.timeout,
      }))
  const client = createClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
  })

  if (config.provider === "openai-compatible") {
    const createOpenAICompatibleProvider =
      input.createOpenAICompatibleProviderImpl ?? (await loadOpenAICompatibleProviderFactory())

    return createOpenAICompatibleProvider({
      model: config.model,
      client,
    })
  }

  const createProvider = input.createOpenAIProviderImpl ?? createOpenAIProvider

  return createProvider({
    model: config.model,
    client,
  })
}

export function buildCli(input: BuildCliInput = {}) {
  return {
    parse(argv: string[]) {
      return parseRunCommand(argv)
    },
    async run(argv: string[]) {
      parseRunCommand(argv)
      const runCliImpl = input.runCliImpl ?? runCli
      const serverOrigin = resolveAgentServerOrigin(input.env)

      if (serverOrigin) {
        await runCliImpl({
          argv,
          io: input.createIo?.() ?? createStdioCliIo(),
          client: (input.createAgentServerClientImpl ?? createAgentServerClient)({
            origin: serverOrigin,
          }),
        })
        return
      }

      const provider =
        input.provider ??
        (await createDefaultProvider({
          env: input.env,
          createClient: input.createClient,
          createOpenAIProviderImpl: input.createOpenAIProviderImpl,
          createOpenAICompatibleProviderImpl: input.createOpenAICompatibleProviderImpl,
        }))

      await runCliImpl({
        argv,
        io: input.createIo?.() ?? createStdioCliIo(),
        provider,
      })
    },
  }
}

if (import.meta.main) {
  const cli = buildCli()

  try {
    await cli.run(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
