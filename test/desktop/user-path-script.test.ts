import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("desktop user-path verify script", () => {
  test("exposes a reusable desktop:verify script and keeps the key user-path assertions", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>
    }
    const scriptSource = readFileSync("scripts/desktop-user-path-check.mjs", "utf8")

    expect(packageJson.scripts?.["desktop:verify"]).toBe("node ./scripts/desktop-user-path-check.mjs")
    expect(scriptSource).toContain("window.neoCoworkerDesktop.persistedWorkspaceRoot")
    expect(scriptSource).toContain("page.getByRole(\"button\", { name: /Settings|设置/ })")
    expect(scriptSource).toContain("page.getByTitle(\"New Session\")")
    expect(scriptSource).toContain("page.locator(\"button[type=submit]\")")
    expect(scriptSource).toContain("part.kind === \"text\"")
    expect(scriptSource).toContain("Assistant transcript text is empty.")
  })
})
