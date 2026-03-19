import { describe, expect, test } from "bun:test"
import {
  ALLOWED_TOP_LEVELS,
  STRUCTURE_BASELINE_PATH,
  formatFinding,
  loadRepositoryGraph,
  loadStructureBaseline,
  partitionFindings,
  validateRepositoryGraph,
} from "./architecture-harness"

describe("architecture structure", () => {
  test("detects a cross-domain import violation", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "conversation/service/query.ts",
          to: "model/index.ts",
          specifier: "../../model",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
  })

  test("detects a runtime-to-repo import violation", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
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
      directories: ["conversation"],
      files: [
        "conversation/types/message.ts",
        "conversation/config/defaults.ts",
        "conversation/repo/index.ts",
        "conversation/ports/telemetry.ts",
        "conversation/service/index.ts",
        "conversation/runtime/api.ts",
      ],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("missing its required root index.ts")
  })

  test("allows outer-shell composition to depend on a domain root index", () => {
    const findings = validateRepositoryGraph({
      directories: ["wiring"],
      files: ["orchestration/index.ts"],
      edges: [
        {
          from: "wiring/main.ts",
          to: "orchestration/index.ts",
          specifier: "../orchestration",
        },
      ],
    })

    expect(findings).toEqual([])
  })

  test("detects outer-shell composition importing a domain internal file", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "wiring/main.ts",
          to: "conversation/repo/index.ts",
          specifier: "../conversation/repo",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
  })

  test("detects an unsupported layer directory", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: ["conversation/wiring/provider.ts"],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("[INV-STRUCTURE-001]")
  })

  test("formats findings with a stable id and remediation text", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "conversation/service/query.ts",
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
