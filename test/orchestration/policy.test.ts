import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ORCHESTRATION_PERMISSION_POLICY,
  resolvePermissionPolicy,
} from "../../src/orchestration"

describe("orchestration permission policy", () => {
  test("defaults websearch to allow while keeping webfetch permission-gated", () => {
    expect(DEFAULT_ORCHESTRATION_PERMISSION_POLICY).toMatchObject({
      websearch: "allow",
      webfetch: "ask",
    })
  })

  test("merges explicit overrides on top of the product defaults", () => {
    expect(
      resolvePermissionPolicy({
        websearch: "deny",
        shell: "allow",
      }),
    ).toMatchObject({
      websearch: "deny",
      webfetch: "ask",
      shell: "allow",
    })
  })
})
