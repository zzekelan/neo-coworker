import { describe, expect, test } from "bun:test"
import {
  APPROVED_TOP_LEVELS,
  FINAL_CAPABILITY_TOP_LEVELS,
  FINAL_COORDINATOR_TOP_LEVELS,
  FINAL_KERNEL_TOP_LEVELS,
  FINAL_SHELL_TOP_LEVELS,
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
    expect(toSortedArray(FINAL_CAPABILITY_TOP_LEVELS)).toEqual([
      "model",
      "permission",
      "session",
      "tool",
    ])
    expect(toSortedArray(FINAL_COORDINATOR_TOP_LEVELS)).toEqual([
      "orchestration",
    ])
    expect(toSortedArray(FINAL_SHELL_TOP_LEVELS)).toEqual([
      "app-server",
      "bootstrap",
      "cli",
    ])
    expect(toSortedArray(FINAL_KERNEL_TOP_LEVELS)).toEqual(["kernel"])
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

  test("detects retired six-layer directories as migration debt", () => {
    const findings = validateRepositoryGraph({
      directories: ["session"],
      files: ["session/runtime/api.ts"],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("[INV-STRUCTURE-001]")
    expect(formatFindings(findings).join("\n")).toContain("retired internal directory")
  })

  test("detects an unsupported shared-kernel directory", () => {
    const findings = validateRepositoryGraph({
      directories: ["kernel"],
      files: ["kernel/index.ts", "kernel/types/run-status.ts"],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("[INV-STRUCTURE-002]")
    expect(formatFindings(findings).join("\n")).toContain("not allowed in the shared kernel")
  })

  test("detects a capability root exporting through a retired layer", () => {
    const findings = validateRepositoryGraph({
      directories: ["session"],
      files: ["session/index.ts", "session/runtime/api.ts"],
      edges: [
        {
          from: "session/index.ts",
          to: "session/runtime/api.ts",
          specifier: "./runtime/api",
          kind: "export",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-PUBLIC-001]")
    expect(formatFindings(findings).join("\n")).toContain("may only re-export src/session/public/*")
  })

  test("detects a retired public re-export ladder", () => {
    const findings = validateRepositoryGraph({
      directories: ["session"],
      files: ["session/runtime/api.ts", "session/service/index.ts"],
      edges: [
        {
          from: "session/runtime/api.ts",
          to: "session/service/index.ts",
          specifier: "../service",
          kind: "export",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-PUBLIC-001]")
    expect(formatFindings(findings).join("\n")).toContain("re-exports through retired internal layers")
  })

  test("detects a capability-layer dependency violation in the target layout", () => {
    const findings = validateRepositoryGraph({
      directories: ["session"],
      files: [
        "session/index.ts",
        "session/public/index.ts",
        "session/application/query.ts",
        "session/domain/run.ts",
        "session/infrastructure/sqlite.ts",
      ],
      edges: [
        {
          from: "session/application/query.ts",
          to: "session/infrastructure/sqlite.ts",
          specifier: "../infrastructure/sqlite",
          kind: "import",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-LAYER-002]")
    expect(formatFindings(findings).join("\n")).toContain("inside a capability module")
  })

  test("allows the public boundary to expose a stable infrastructure-backed factory", () => {
    const findings = validateRepositoryGraph({
      directories: ["session"],
      files: [
        "session/index.ts",
        "session/public/index.ts",
        "session/infrastructure/sqlite.ts",
      ],
      edges: [
        {
          from: "session/public/index.ts",
          to: "session/infrastructure/sqlite.ts",
          specifier: "../infrastructure/sqlite",
          kind: "export",
        },
      ],
    })

    expect(findings).toEqual([])
  })

  test("detects a module-internal import routed through its own root index", () => {
    const findings = validateRepositoryGraph({
      directories: ["orchestration"],
      files: [
        "orchestration/index.ts",
        "orchestration/public/index.ts",
        "orchestration/application/run.ts",
      ],
      edges: [
        {
          from: "orchestration/application/run.ts",
          to: "orchestration/index.ts",
          specifier: "../index",
          kind: "import",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-LAYER-002]")
    expect(formatFindings(findings).join("\n")).toContain("may not import its own module root")
  })

  test("detects a coordinator importing a capability module directly", () => {
    const findings = validateRepositoryGraph({
      directories: ["orchestration", "session"],
      files: ["orchestration/index.ts", "session/index.ts"],
      edges: [
        {
          from: "orchestration/application/run.ts",
          to: "session/index.ts",
          specifier: "../../session",
          kind: "import",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
    expect(formatFindings(findings).join("\n")).toContain("within the coordinator module")
  })

  test("allows shell composition to import another module through its root index", () => {
    const findings = validateRepositoryGraph({
      directories: ["bootstrap", "orchestration"],
      files: ["bootstrap/index.ts", "orchestration/index.ts"],
      edges: [
        {
          from: "bootstrap/runtime.ts",
          to: "orchestration/index.ts",
          specifier: "../orchestration",
          kind: "import",
        },
      ],
    })

    expect(findings).toEqual([])
  })

  test("detects a non-bootstrap shell importing a module root directly", () => {
    const findings = validateRepositoryGraph({
      directories: ["app-server", "bootstrap", "session"],
      files: ["app-server/index.ts", "bootstrap/index.ts", "session/index.ts"],
      edges: [
        {
          from: "app-server/app.ts",
          to: "session/index.ts",
          specifier: "../session",
          kind: "import",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
    expect(formatFindings(findings).join("\n")).toContain("non-bootstrap shell module")
    expect(formatFindings(findings).join("\n")).toContain("src/bootstrap/index.ts")
  })

  test("detects a missing shell root index", () => {
    const findings = validateRepositoryGraph({
      directories: ["app-server"],
      files: ["app-server/main.ts"],
      edges: [],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-PUBLIC-001]")
    expect(formatFindings(findings).join("\n")).toContain("missing its required root index.ts public exit")
  })

  test("detects a deep cross-module import into internals", () => {
    const findings = validateRepositoryGraph({
      directories: ["bootstrap", "session"],
      files: ["bootstrap/index.ts", "session/index.ts", "session/repo/index.ts"],
      edges: [
        {
          from: "bootstrap/runtime.ts",
          to: "session/repo/index.ts",
          specifier: "../session/repo",
          kind: "import",
        },
      ],
    })

    expect(formatFindings(findings).join("\n")).toContain("[ARCH-CROSS-001]")
    expect(formatFindings(findings).join("\n")).toContain("may not import internal file")
  })

  test("formats findings with a stable id and remediation text", () => {
    const findings = validateRepositoryGraph({
      directories: ["app-server", "session"],
      files: ["app-server/index.ts", "session/index.ts", "session/repo/index.ts"],
      edges: [
        {
          from: "app-server/app.ts",
          to: "session/repo/index.ts",
          specifier: "../session/repo",
          kind: "import",
        },
      ],
    })

    const message = formatFindings(findings)[0]

    expect(message).toContain("[ARCH-CROSS-001]")
    expect(message).toContain("src/session/index.ts")
    expect(message).toContain("See docs/ARCHITECTURE.md#cross-module-boundaries.")
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
