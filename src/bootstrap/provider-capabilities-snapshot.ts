import type { ModelsDevCatalog } from "./provider-capabilities"

export const MODELS_DEV_CAPABILITY_SNAPSHOT = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        tool_call: true,
        experimental: {
          modes: {
            low: { provider: { body: { reasoning_effort: "low" } } },
            medium: { provider: { body: { reasoning_effort: "medium" } } },
            high: { provider: { body: { reasoning_effort: "high" } } },
          },
        },
      },
      "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        reasoning: true,
        tool_call: true,
        experimental: {
          modes: {
            low: { provider: { body: { reasoning_effort: "low" } } },
            medium: { provider: { body: { reasoning_effort: "medium" } } },
            high: { provider: { body: { reasoning_effort: "high" } } },
          },
        },
      },
    },
  },
  moonshotai: {
    id: "moonshotai",
    name: "Moonshot AI",
    models: {
      "kimi-k2.5": {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: true,
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        experimental: {
          modes: {
            low: {
              provider: {
                body: { reasoning_effort: "low", thinking: { keep: "all" } },
              },
            },
            medium: {
              provider: {
                body: { reasoning_effort: "medium", thinking: { keep: "all" } },
              },
            },
            high: {
              provider: {
                body: { reasoning_effort: "high", thinking: { keep: "all" } },
              },
            },
          },
        },
      },
      "kimi-k2.6": {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        reasoning: true,
        tool_call: true,
        interleaved: { field: "reasoning_content" },
        experimental: {
          modes: {
            low: {
              provider: {
                body: { reasoning_effort: "low", thinking: { keep: "all" } },
              },
            },
            medium: {
              provider: {
                body: { reasoning_effort: "medium", thinking: { keep: "all" } },
              },
            },
            high: {
              provider: {
                body: { reasoning_effort: "high", thinking: { keep: "all" } },
              },
            },
          },
        },
      },
    },
  },
} satisfies ModelsDevCatalog
