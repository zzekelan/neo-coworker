import { describe, expect, test } from "bun:test"
import { buildCli, resolveDefaultProviderConfig } from "../src/main"

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

  test("validates argv before requiring default provider configuration", async () => {
    const cli = buildCli()

    await expect(cli.run(["status"])).rejects.toThrow("Only `run` is supported in MVP")
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
})
