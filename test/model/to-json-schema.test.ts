import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { toJsonSchema } from "../../src/model/infrastructure/adapters/openai-compatible"

describe("toJsonSchema", () => {
  test("preserves descriptions on primitive schemas", () => {
    expect(toJsonSchema(z.string().describe("File path"))).toEqual({
      type: "string",
      description: "File path",
    })

    expect(toJsonSchema(z.number().describe("Start line"))).toEqual({
      type: "number",
      description: "Start line",
    })

    expect(toJsonSchema(z.boolean().describe("Enabled flag"))).toEqual({
      type: "boolean",
      description: "Enabled flag",
    })
  })

  test("preserves descriptions on literal and enum schemas", () => {
    expect(toJsonSchema(z.literal("read").describe("Mode"))).toEqual({
      type: "string",
      enum: ["read"],
      description: "Mode",
    })

    expect(toJsonSchema(z.enum(["fast", "slow"]).describe("Execution mode"))).toEqual({
      type: "string",
      enum: ["fast", "slow"],
      description: "Execution mode",
    })
  })

  test("preserves descriptions on arrays and nested item schemas", () => {
    expect(
      toJsonSchema(
        z.array(z.string().describe("Item path")).describe("List of paths"),
      ),
    ).toEqual({
      type: "array",
      description: "List of paths",
      items: {
        type: "string",
        description: "Item path",
      },
    })
  })

  test("preserves descriptions on optional, default, nullable, and effect wrappers", () => {
    expect(toJsonSchema(z.string().describe("Optional limit").optional())).toEqual({
      type: "string",
      description: "Optional limit",
    })

    expect(toJsonSchema(z.string().describe("Default value").default("x"))).toEqual({
      type: "string",
      description: "Default value",
    })

    expect(toJsonSchema(z.string().describe("Nullable value").nullable())).toEqual({
      type: "string",
      description: "Nullable value",
    })

    expect(
      toJsonSchema(
        z.string().describe("Transformed value").transform((value) => value.trim()),
      ),
    ).toEqual({
      type: "string",
      description: "Transformed value",
    })
  })

  test("preserves descriptions on nested object schemas", () => {
    expect(
      toJsonSchema(
        z
          .object({
            path: z.string().describe("File path"),
            offset: z.number().describe("Start line"),
            limit: z.string().describe("Optional limit").optional(),
          })
          .describe("Read request"),
      ),
    ).toEqual({
      type: "object",
      description: "Read request",
      properties: {
        path: { type: "string", description: "File path" },
        offset: { type: "number", description: "Start line" },
        limit: { type: "string", description: "Optional limit" },
      },
      required: ["path", "offset"],
      additionalProperties: false,
    })
  })
})
