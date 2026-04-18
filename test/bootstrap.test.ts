import { describe, expect, test } from "bun:test"
import { buildCli } from "../src/cli"
import {
  createDefaultSearchBackend,
  resolveDefaultProviderConfig,
  resolveContextWindowSize,
  resolveSearchBackendConfig,
} from "../src/bootstrap"

describe("bootstrap", () => {
  test("parses the run command", () => {
    const cli = buildCli()
    expect(cli.parse(["run", "hello runtime"])).toEqual({
      command: "run",
      prompt: "hello runtime",
    })
  })

  test("parses an existing session target for the run command", () => {
    const cli = buildCli()
    expect(cli.parse(["run", "--session", "session_123", "hello again"])).toEqual({
      command: "run",
      prompt: "hello again",
      sessionId: "session_123",
    })
  })

  test("parses an agent target for the run command", () => {
    const cli = buildCli()
    expect(cli.parse(["run", "--agent", "plan", "hello again"])).toEqual({
      command: "run",
      prompt: "hello again",
      agent: "plan",
    })
  })

  test("parses an agent target for the chat command", () => {
    const cli = buildCli()
    expect(cli.parse(["chat", "--agent", "plan"])).toEqual({
      command: "chat",
      agent: "plan",
    })
  })

  test("prints CLI help text including --agent", async () => {
    const output: string[] = []
    const cli = buildCli({
      createIo() {
        return {
          write(text: string) {
            output.push(text)
          },
          async prompt() {
            throw new Error("prompt should not be called")
          },
        }
      },
    })

    await expect(cli.run(["--help"])).rejects.toThrow(/--agent <name>/)
    expect(output).toEqual([])
  })

  test("allows prompt tokens that start with -- after prompt text begins", () => {
    const cli = buildCli()
    expect(cli.parse(["run", "Explain", "--help", "output"])).toEqual({
      command: "run",
      prompt: "Explain --help output",
    })
  })

  test("supports -- as the option terminator for prompt text", () => {
    const cli = buildCli()
    expect(cli.parse(["run", "--", "--help", "output"])).toEqual({
      command: "run",
      prompt: "--help output",
    })
  })

  test("parses the chat command", () => {
    const cli = buildCli()
    expect(cli.parse(["chat"])).toEqual({
      command: "chat",
    })
  })

  test("parses the insights command", () => {
    const cli = buildCli()
    expect(cli.parse(["insights"])).toEqual({
      command: "insights",
    })
  })

  test("parses an existing session target for the chat command", () => {
    const cli = buildCli()
    expect(cli.parse(["chat", "--session", "session_123"])).toEqual({
      command: "chat",
      sessionId: "session_123",
    })
  })

  test("validates argv before requiring default provider configuration", async () => {
    const cli = buildCli()

    await expect(cli.run(["status"])).rejects.toThrow(
      "Only `run`, `chat`, `insights`, and `permissions` are supported",
    )
  })

  test("runs permissions commands without requiring default provider configuration", async () => {
    const runCliCalls: Array<Parameters<typeof import("../src/cli").runCli>[0]> = []
    const cli = buildCli({
      runCliImpl: async (input) => {
        runCliCalls.push(input)
      },
    })

    await expect(cli.run(["permissions", "allowlist", "list"])).resolves.toBeUndefined()
    expect(runCliCalls).toHaveLength(1)
    expect(runCliCalls[0]).toMatchObject({
      argv: ["permissions", "allowlist", "list"],
    })
    expect("createLocalStorageImpl" in runCliCalls[0]).toBe(true)
    expect("provider" in runCliCalls[0]).toBe(false)
  })

  test("reads default provider configuration from LLM_* variables", () => {
    expect(
      resolveDefaultProviderConfig({
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "kimi-k2.5",
        LLM_BASE_URL: "https://coding.example.com/v1",
        LLM_TIMEOUT_MS: "30000",
      }),
    ).toEqual({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "kimi-k2.5",
      baseURL: "https://coding.example.com/v1",
      timeout: 30000,
    })
  })

  test("requires LLM_PROVIDER", () => {
    expect(() =>
      resolveDefaultProviderConfig({
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
      }),
    ).toThrow("LLM_PROVIDER is required")
  })

  test("rejects unsupported LLM_PROVIDER values", () => {
    expect(() =>
      resolveDefaultProviderConfig({
        LLM_PROVIDER: "kimi",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
      }),
    ).toThrow("LLM_PROVIDER must be one of: openai, openai-compatible")
  })

  test("requires LLM_BASE_URL for openai-compatible", () => {
    expect(() =>
      resolveDefaultProviderConfig({
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "kimi-k2.5",
      }),
    ).toThrow("LLM_BASE_URL is required when LLM_PROVIDER=openai-compatible")
  })

  test("requires LLM_MODEL for openai-compatible", () => {
    expect(() =>
      resolveDefaultProviderConfig({
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_BASE_URL: "https://coding.example.com/v1",
      }),
    ).toThrow("LLM_MODEL is required when LLM_PROVIDER=openai-compatible")
  })

  test("does not fall back to OPENAI_* variables", () => {
    expect(() =>
      resolveDefaultProviderConfig({
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "legacy-key",
        OPENAI_MODEL: "gpt-5",
      }),
    ).toThrow("LLM_API_KEY is required")
  })

  test("reads search backend configuration from SEARCH_BACKEND_* variables", () => {
    expect(
      resolveSearchBackendConfig({
        SEARCH_BACKEND_URL: "https://search.example.com/tools",
        SEARCH_BACKEND_BEARER_TOKEN: "search-secret",
      }),
    ).toEqual({
      url: "https://search.example.com/tools",
      bearerToken: "search-secret",
    })
  })

  test("rejects invalid SEARCH_BACKEND_URL values", () => {
    expect(() =>
      resolveSearchBackendConfig({
        SEARCH_BACKEND_URL: "search.example.com/tools",
      }),
    ).toThrow("SEARCH_BACKEND_URL must be a valid absolute URL")
  })

  test("falls back to the built-in public search backend when SEARCH_BACKEND_URL is absent", () => {
    const searchBackend = createDefaultSearchBackend({})

    expect(searchBackend).toBeDefined()
  })

  test("prefers LLM_CONTEXT_WINDOW over provider metadata lookups", async () => {
    const result = await resolveContextWindowSize({
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
        LLM_CONTEXT_WINDOW: "8192",
      },
      fetchImpl: async () => {
        throw new Error("fetch should not be called when LLM_CONTEXT_WINDOW is set")
      },
    })

    expect(result).toEqual({
      contextWindow: 8192,
      source: "env",
    })
  })

  test("reads provider-reported context window metadata when available", async () => {
    let requestedUrl = ""
    let requestedHeaders: HeadersInit | undefined

    const result = await resolveContextWindowSize({
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "fake-model",
        LLM_BASE_URL: "https://example.invalid/v1",
      },
      fetchImpl: async (input, init) => {
        requestedUrl = String(input)
        requestedHeaders = init?.headers

        return new Response(JSON.stringify({ context_length: 65536 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    expect(result).toEqual({
      contextWindow: 65536,
      source: "provider",
    })
    expect(requestedUrl).toBe("https://example.invalid/v1/models/fake-model")
    expect(requestedHeaders).toEqual({
      Authorization: "Bearer test-key",
      Accept: "application/json",
    })
  })

  test("falls back to the default context window when provider metadata is unavailable", async () => {
    const result = await resolveContextWindowSize({
      env: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-5",
      },
      fetchImpl: async () => {
        throw new Error("network down")
      },
    })

    expect(result).toEqual({
      contextWindow: 128000,
      source: "default",
    })
  })

  test("does not block startup when provider context window metadata hangs", async () => {
    const result = await resolveContextWindowSize({
      env: {
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "slow-model",
        LLM_BASE_URL: "https://example.invalid/v1",
      },
      metadataTimeoutMs: 1,
      fetchImpl: async () => new Promise<Response>(() => {}),
    })

    expect(result).toEqual({
      contextWindow: 128000,
      source: "default",
    })
  })
})
