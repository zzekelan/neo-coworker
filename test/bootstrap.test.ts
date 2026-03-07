import { describe, expect, test } from "bun:test"
import { buildCli } from "../src/main"

describe("bootstrap", () => {
  test("parses the run command", () => {
    const cli = buildCli()
    expect(cli.parse(["run", "hello runtime"])).toEqual({
      command: "run",
      prompt: "hello runtime",
    })
  })
})
