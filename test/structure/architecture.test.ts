import { describe, expect, test } from "bun:test"
import {
  APPROVED_TOP_LEVELS,
  FINAL_CORE_TOP_LEVELS,
  FINAL_OUTER_SHELL_TOP_LEVELS,
  STRUCTURE_BASELINE_PATH,
  TRANSITION_CORE_TOP_LEVELS,
  TRANSITION_OUTER_SHELL_TOP_LEVELS,
  formatFinding,
  loadRepositoryGraph,
  loadStructureBaseline,
  partitionFindings,
  validateRepositoryGraph,
} from "./architecture-harness"

describe("architecture structure", () => {
  test("declares the final target vocabulary explicitly", () => {
    expect(toSortedArray(FINAL_CORE_TOP_LEVELS)).toEqual([
      "model",
      "orchestration",
      "permission",
      "session",
      "tool",
    ])
    expect(toSortedArray(FINAL_OUTER_SHELL_TOP_LEVELS)).toEqual([
      "app-server",
      "bootstrap",
      "cli",
    ])
  })

  test("tracks transition-only names as explicit debt during migration", () => {
    expect(toSortedArray(TRANSITION_CORE_TOP_LEVELS)).toEqual(["conversation"])
    expect(toSortedArray(TRANSITION_OUTER_SHELL_TOP_LEVELS)).toEqual([
      "server",
      "wiring",
    ])
    expect(APPROVED_TOP_LEVELS.has("conversation")).toBe(false)
    expect(APPROVED_TOP_LEVELS.has("wiring")).toBe(false)

    const findings = validateRepositoryGraph({
      directories: ["wiring"],
      files: ["wiring/main.ts"],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("transition-only top-level")
  })

  test("detects a cross-domain import violation", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(APPROVED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "session/service/query.ts",
          to: "model/index.ts",
          specifier: "../../model",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
  })

  test("detects a runtime-to-repo import violation", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(APPROVED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "model/runtime/api.ts",
          to: "model/repo/index.ts",
          specifier: "../repo",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-LAYER-001]")
  })

  test("detects a missing required domain layer", () => {
    const findings = validateRepositoryGraph({
      directories: ["model"],
      files: [
        "model/index.ts",
        "model/types/event.ts",
        "model/config/defaults.ts",
        "model/repo/index.ts",
        "model/service/index.ts",
        "model/runtime/api.ts",
      ],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("missing its required ports/ layer")
  })

  test("detects a missing domain root index", () => {
    const findings = validateRepositoryGraph({
      directories: ["session"],
      files: [
        "session/types/message.ts",
        "session/config/defaults.ts",
        "session/repo/index.ts",
        "session/ports/telemetry.ts",
        "session/service/index.ts",
        "session/runtime/api.ts",
      ],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("missing its required root index.ts")
  })

  test("allows outer-shell composition to depend on a domain root index", () => {
    const findings = validateRepositoryGraph({
      directories: ["bootstrap"],
      files: ["orchestration/index.ts"],
      edges: [
        {
          from: "bootstrap/runtime.ts",
          to: "orchestration/index.ts",
          specifier: "../orchestration",
        },
      ],
    })

    expect(findings).toEqual([])
  })

  test("detects outer-shell composition importing a domain internal file", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(APPROVED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "bootstrap/runtime.ts",
          to: "session/repo/index.ts",
          specifier: "../session/repo",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
  })

  test("detects an unsupported layer directory", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(APPROVED_TOP_LEVELS),
      files: ["session/wiring/provider.ts"],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("[INV-STRUCTURE-001]")
  })

  test("formats findings with a stable id and remediation text", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(APPROVED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "session/service/query.ts",
          to: "model/runtime/api.ts",
          specifier: "../../model/runtime/api",
        },
      ],
    })

    const message = formatFindings(findings)[0]

    expect(message).toContain("[ARCH-CROSS-001]")
    expect(message).toContain("Define the external capability in the importing domain's ports/")
    expect(message).toContain("See docs/ARCHITECTURE.md#cross-domain-boundaries.")
  })

  test("repository structure only contains baselined findings", async () => {
    const graph = await loadRepositoryGraph()
    const findings = validateRepositoryGraph(graph)
    const baseline = await loadStructureBaseline(STRUCTURE_BASELINE_PATH)
    const { unbaselined } = partitionFindings(findings, baseline)

    expect(formatFindings(unbaselined)).toEqual([])
  })

  test("baseline debt file stays in sync with the remaining violations", async () => {
    const graph = await loadRepositoryGraph()
    const findings = validateRepositoryGraph(graph)
    const baseline = await loadStructureBaseline(STRUCTURE_BASELINE_PATH)
    const { staleBaseline } = partitionFindings(findings, baseline)

    expect(
      staleBaseline.map(
        (entry) =>
          `[${entry.ruleId}] ${entry.fingerprint} is no longer present. Remove it from test/structure/baselines/architecture-findings.json.`,
      ),
    ).toEqual([])
  })
})

function formatFindings(findings: ReturnType<typeof validateRepositoryGraph>) {
  return findings.map(formatFinding)
}

function toSortedArray(values: Set<string>) {
  return Array.from(values).sort()
}
