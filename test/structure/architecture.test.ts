import { describe, expect, test } from "bun:test"
import {
  ALLOWED_TOP_LEVELS,
  STRUCTURE_BASELINE_PATH,
  formatFinding,
  loadRepositoryGraph,
  loadStructureBaseline,
  partitionFindings,
  validateRepositoryGraph,
  type RepositoryGraph,
} from "./architecture-harness"

describe("architecture structure", () => {
  test("detects a cross-domain import violation", () => {
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

  test("detects a wiring-to-service import violation", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "tool/wiring/provider.ts",
          to: "tool/service/index.ts",
          specifier: "../service",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-LAYER-001]")
  })

  test("detects a repo-to-service import violation", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "conversation/repo/index.ts",
          to: "conversation/service/index.ts",
          specifier: "../service",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-LAYER-001]")
  })

  test("allows provider wiring to depend on consumer ports", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "model/wiring/provider.ts",
          to: "orchestration/ports/model.ts",
          specifier: "../../orchestration/ports/model",
        },
      ],
    })

    expect(findings).toEqual([])
  })

  test("detects domain wiring importing another domain repo", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: [],
      edges: [
        {
          from: "orchestration/wiring/runtime.ts",
          to: "conversation/repo/index.ts",
          specifier: "../../conversation/repo",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
  })

  test("detects an unsupported layer directory", () => {
    const findings = validateRepositoryGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      files: ["conversation/adapter/query.ts"],
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
    expect(message).toContain("Keep cross-domain calls behind ports and wiring")
    expect(message).toContain("See ARCHITECTURE.md#cross-domain-boundaries.")
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
