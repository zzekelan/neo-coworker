import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, normalize } from "node:path"

export const SOURCE_ROOT = join(process.cwd(), "src")
export const STRUCTURE_BASELINE_PATH = join(
  process.cwd(),
  "test",
  "structure",
  "baselines",
  "architecture-findings.json",
)
export const FINAL_CAPABILITY_TOP_LEVELS = new Set([
  "observability",
  "model",
  "permission",
  "session",
  "skill",
  "tool",
])
export const FINAL_COORDINATOR_TOP_LEVELS = new Set(["orchestration"])
export const FINAL_SHELL_TOP_LEVELS = new Set([
  "app-server",
  "bootstrap",
  "cli",
  "desktop",
])
export const FINAL_KERNEL_TOP_LEVELS = new Set(["kernel"])
export const APPROVED_TOP_LEVELS = new Set([
  ...FINAL_CAPABILITY_TOP_LEVELS,
  ...FINAL_COORDINATOR_TOP_LEVELS,
  ...FINAL_SHELL_TOP_LEVELS,
  ...FINAL_KERNEL_TOP_LEVELS,
])
export const ALLOWED_TOP_LEVELS = new Set([...APPROVED_TOP_LEVELS])
export const LEGACY_TOP_LEVELS = new Set([
  "conversation",
  "providers",
  "runtime",
  "server",
  "wiring",
])
export const RETIRED_INTERNAL_DIRECTORIES = new Set([
  "config",
  "ports",
  "repo",
  "runtime",
  "service",
  "types",
  "wiring",
])

const CAPABILITY_TARGET_DIRECTORIES = new Set([
  "public",
  "application",
  "domain",
  "infrastructure",
])
const COORDINATOR_TARGET_DIRECTORIES = new Set([
  "public",
  "application",
  "infrastructure",
])
const KERNEL_TARGET_DIRECTORIES = new Set(["contracts"])
const IMPORT_EXPORT_PATTERN =
  /\b(import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g
const RULE_DOCS = {
  "ARCH-TOPLEVEL-001": "docs/ARCHITECTURE.md#top-level-map",
  "ARCH-LAYER-001": "docs/ARCHITECTURE.md#module-layouts",
  "ARCH-LAYER-002": "docs/ARCHITECTURE.md#internal-module-boundaries",
  "ARCH-CROSS-001": "docs/ARCHITECTURE.md#cross-module-boundaries",
  "ARCH-PUBLIC-001": "docs/ARCHITECTURE.md#public-export-contract",
  "INV-STRUCTURE-001":
    "docs/dev/QUALITY_INVARIANTS.md#inv-structure-001-approved-module-role-layouts",
  "INV-STRUCTURE-002":
    "docs/dev/QUALITY_INVARIANTS.md#inv-structure-002-shared-kernel-stays-narrow",
  "INV-BOUNDARY-003":
    "docs/dev/QUALITY_INVARIANTS.md#inv-boundary-003-adapter-subroles-depend-on-precise-ports",
} as const
const CAPABILITY_ALLOWED_INTERNAL_IMPORTS = {
  public: new Set(["application", "infrastructure"]),
  application: new Set(["application-port", "domain"]),
  "application-port": new Set<string>(),
  domain: new Set<string>(),
  infrastructure: new Set(["application", "application-port", "domain"]),
} as const
const COORDINATOR_ALLOWED_INTERNAL_IMPORTS = {
  public: new Set(["application", "infrastructure"]),
  application: new Set(["application-port"]),
  "application-port": new Set<string>(),
  infrastructure: new Set(["application", "application-port"]),
} as const

export type StructureRuleId =
  | "ARCH-TOPLEVEL-001"
  | "ARCH-LAYER-001"
  | "ARCH-LAYER-002"
  | "ARCH-CROSS-001"
  | "ARCH-PUBLIC-001"
  | "INV-STRUCTURE-001"
  | "INV-STRUCTURE-002"
  | "INV-BOUNDARY-003"

export type EdgeKind = "import" | "export"

export type ImportEdge = {
  from: string
  to: string
  specifier: string
  kind: EdgeKind
}

export type RepositoryGraph = {
  directories: string[]
  files: string[]
  edges: ImportEdge[]
}

export type StructureFinding = {
  ruleId: StructureRuleId
  fingerprint: string
  summary: string
  remediation: string
  doc: (typeof RULE_DOCS)[StructureRuleId]
}

export type StructureBaselineEntry = {
  fingerprint: string
  ruleId: StructureRuleId
  note: string
}

type ModuleKind =
  | "capability"
  | "coordinator"
  | "shell"
  | "kernel"
  | "unknown"

type SourcePlacement =
  | "module-index"
  | "public"
  | "application"
  | "application-port"
  | "domain"
  | "infrastructure"
  | "contracts"
  | "retired"
  | "shell-internal"
  | "unknown"

type SourceFileMeta = {
  relPath: string
  topLevel: string
  moduleKind: ModuleKind
  primaryDir: string | null
  secondaryDir: string | null
  placement: SourcePlacement
  retiredDir: string | null
  isModuleIndex: boolean
  isFinalModule: boolean
}

type ModuleState = {
  hasIndex: boolean
  primaryDirs: Set<string>
}

type CapabilityPlacement =
  | "public"
  | "application"
  | "application-port"
  | "domain"
  | "infrastructure"

type CoordinatorPlacement =
  | "public"
  | "application"
  | "application-port"
  | "infrastructure"

export async function loadRepositoryGraph(): Promise<RepositoryGraph> {
  const directories = await listTopLevelDirectories(SOURCE_ROOT)
  const files = await listTypeScriptFiles(SOURCE_ROOT)
  const fileSet = new Set(files)
  const edges: ImportEdge[] = []

  for (const file of files) {
    const source = await readFile(join(SOURCE_ROOT, file), "utf8")

    for (const statement of extractImportStatements(source)) {
      const resolved = resolveLocalImport(file, statement.specifier, fileSet)
      if (!resolved) {
        continue
      }

      edges.push({
        from: file,
        to: resolved,
        specifier: statement.specifier,
        kind: statement.kind,
      })
    }
  }

  return {
    directories,
    files,
    edges,
  }
}

export function validateRepositoryGraph(graph: RepositoryGraph) {
  const findings = new Map<string, StructureFinding>()
  const moduleState = collectModuleState(graph)

  for (const directory of graph.directories) {
    if (LEGACY_TOP_LEVELS.has(directory)) {
      addFinding(findings, {
        ruleId: "ARCH-TOPLEVEL-001",
        fingerprint: `ARCH-TOPLEVEL-001:top-level:${directory}`,
        summary: `src/${directory} is a legacy top-level directory and must not reappear.`,
        remediation:
          "Move the code into one of the approved module top-levels and keep retired pre-split names out of new changes.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
      continue
    }

    if (!ALLOWED_TOP_LEVELS.has(directory)) {
      addFinding(findings, {
        ruleId: "ARCH-TOPLEVEL-001",
        fingerprint: `ARCH-TOPLEVEL-001:top-level:${directory}`,
        summary: `src/${directory} is not an approved top-level module.`,
        remediation:
          "Place the code under an approved capability, coordinator, shell, or kernel top-level, or update docs/ARCHITECTURE.md and the structure checks in the same change.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
    }

  }

  for (const [moduleName, state] of moduleState) {
    const moduleKind = getModuleKind(moduleName)

    if (requiresModuleIndex(moduleKind) && !state.hasIndex) {
      addFinding(findings, {
        ruleId: "ARCH-PUBLIC-001",
        fingerprint: `ARCH-PUBLIC-001:missing-index:${moduleName}`,
        summary: `src/${moduleName} is missing its required root index.ts public exit.`,
        remediation:
          `Add src/${moduleName}/index.ts as the module's unique public entrypoint before exposing the module to other top-levels.`,
        doc: RULE_DOCS["ARCH-PUBLIC-001"],
      })
    }

    for (const primaryDir of Array.from(state.primaryDirs).sort()) {
      validatePrimaryDirectory(findings, moduleName, moduleKind, primaryDir)
    }
  }

  for (const edge of graph.edges) {
    const from = getSourceFileMeta(edge.from)
    const to = getSourceFileMeta(edge.to)

    if (!ALLOWED_TOP_LEVELS.has(from.topLevel)) {
      continue
    }

    if (!ALLOWED_TOP_LEVELS.has(to.topLevel)) {
      addFinding(findings, {
        ruleId: "ARCH-TOPLEVEL-001",
        fingerprint: `ARCH-TOPLEVEL-001:target:${edge.from}->${edge.to}`,
        summary: `src/${edge.from} references src/${edge.to}, which is outside the approved top-level modules.`,
        remediation:
          "Import only from approved capability, coordinator, shell, or kernel top-levels, or move the target under an approved module boundary.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
      continue
    }

    if (from.topLevel === to.topLevel) {
      validateSameModuleEdge(findings, edge, from, to)
      continue
    }

    validateCrossModuleEdge(findings, edge, from, to)
  }

  return [...findings.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  )
}

export function formatFinding(finding: StructureFinding) {
  return `[${finding.ruleId}] ${finding.summary} ${finding.remediation} See ${finding.doc}.`
}

export async function loadStructureBaseline(path: string = STRUCTURE_BASELINE_PATH) {
  return JSON.parse(await readFile(path, "utf8")) as StructureBaselineEntry[]
}

export function partitionFindings(
  findings: StructureFinding[],
  baseline: StructureBaselineEntry[],
) {
  const baselineFingerprints = new Set(baseline.map((entry) => entry.fingerprint))
  const activeFingerprints = new Set(findings.map((finding) => finding.fingerprint))

  return {
    unbaselined: findings.filter((finding) => !baselineFingerprints.has(finding.fingerprint)),
    staleBaseline: baseline.filter((entry) => !activeFingerprints.has(entry.fingerprint)),
  }
}

function validatePrimaryDirectory(
  findings: Map<string, StructureFinding>,
  moduleName: string,
  moduleKind: ModuleKind,
  primaryDir: string,
) {
  if (moduleKind === "capability" || moduleKind === "coordinator") {
    const approvedPrimaryDirs =
      moduleKind === "capability"
        ? CAPABILITY_TARGET_DIRECTORIES
        : COORDINATOR_TARGET_DIRECTORIES

    if (RETIRED_INTERNAL_DIRECTORIES.has(primaryDir)) {
      addFinding(findings, {
        ruleId: "INV-STRUCTURE-001",
        fingerprint: `INV-STRUCTURE-001:directory:${moduleName}/${primaryDir}`,
        summary: `src/${moduleName}/${primaryDir}/ uses a retired internal directory, which is not approved target structure.`,
        remediation:
          moduleKind === "capability"
            ? "Move the module to public/, application/, domain/, and infrastructure/ instead of adding more files under the retired six-layer vocabulary."
            : "Move the module to public/, application/, and infrastructure/ instead of adding more files under the retired six-layer vocabulary.",
        doc: RULE_DOCS["INV-STRUCTURE-001"],
      })
      return
    }

    if (!approvedPrimaryDirs.has(primaryDir)) {
      addFinding(findings, {
        ruleId: "INV-STRUCTURE-001",
        fingerprint: `INV-STRUCTURE-001:directory:${moduleName}/${primaryDir}`,
        summary: `src/${moduleName}/${primaryDir}/ is not an approved directory for a ${moduleKind} module.`,
        remediation:
          moduleKind === "capability"
            ? "Place capability-module code only under public/, application/, domain/, infrastructure/, or the root index.ts."
            : "Place coordinator-module code only under public/, application/, infrastructure/, or the root index.ts.",
        doc: RULE_DOCS["INV-STRUCTURE-001"],
      })
    }

    return
  }

  if (moduleKind === "kernel" && !KERNEL_TARGET_DIRECTORIES.has(primaryDir)) {
    addFinding(findings, {
      ruleId: "INV-STRUCTURE-002",
      fingerprint: `INV-STRUCTURE-002:directory:${moduleName}/${primaryDir}`,
      summary: `src/${moduleName}/${primaryDir}/ is not allowed in the shared kernel.`,
      remediation:
        "Keep kernel code limited to contracts/ plus the root index.ts, and move module-owned concepts back into their owning module.",
      doc: RULE_DOCS["INV-STRUCTURE-002"],
    })
  }
}

function validateSameModuleEdge(
  findings: Map<string, StructureFinding>,
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  if (!from.isFinalModule || !to.isFinalModule) {
    return
  }

  if (
    !from.isModuleIndex &&
    to.isModuleIndex &&
    protectsOwnModuleRoot(from.moduleKind)
  ) {
    addFinding(findings, {
      ruleId: "ARCH-LAYER-002",
      fingerprint: `ARCH-LAYER-002:self-root:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import its own module root src/${edge.to}.`,
      remediation:
        "Import from the next legal internal layer directly instead of routing same-module dependencies through the public module exit.",
      doc: RULE_DOCS["ARCH-LAYER-002"],
    })
    return
  }

  if (from.isModuleIndex) {
    validateModuleRootEdge(findings, edge, from, to)
    return
  }

  if (from.moduleKind === "capability") {
    validateCapabilityEdge(findings, edge, from, to)
    return
  }

  if (from.moduleKind === "coordinator") {
    validateCoordinatorEdge(findings, edge, from, to)
    return
  }

  if (from.moduleKind === "kernel") {
    validateKernelEdge(findings, edge, from, to)
  }
}

function validateModuleRootEdge(
  findings: Map<string, StructureFinding>,
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  if (from.moduleKind === "capability" || from.moduleKind === "coordinator") {
    if (to.placement !== "public") {
      addFinding(findings, {
        ruleId: "ARCH-PUBLIC-001",
        fingerprint: `ARCH-PUBLIC-001:root-public-only:${edge.from}->${edge.to}`,
        summary: `src/${edge.from} may only re-export src/${from.topLevel}/public/*, but references src/${edge.to}.`,
        remediation:
          "Keep the root index.ts mechanical: move the public surface to public/ and re-export only from that layer.",
        doc: RULE_DOCS["ARCH-PUBLIC-001"],
      })
    }

    return
  }

  if (from.moduleKind === "kernel" && to.placement !== "contracts") {
    addFinding(findings, {
      ruleId: "ARCH-PUBLIC-001",
      fingerprint: `ARCH-PUBLIC-001:root-contracts-only:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may only re-export src/${from.topLevel}/contracts/*, but references src/${edge.to}.`,
      remediation:
        "Keep the kernel root mechanical: re-export only contracts/ and move non-kernel concepts back into their owning module.",
      doc: RULE_DOCS["ARCH-PUBLIC-001"],
    })
  }
}

function validateCapabilityEdge(
  findings: Map<string, StructureFinding>,
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  if (isRetiredPublicBridgeEdge(edge, from, to)) {
    addFinding(findings, {
      ruleId: "ARCH-PUBLIC-001",
      fingerprint: `ARCH-PUBLIC-001:retired-ladder:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} re-exports through retired internal layers by referencing src/${edge.to}.`,
      remediation:
        "Move the public surface to public/ and stop tunneling exports through retired runtime/service/repo-style barrels.",
      doc: RULE_DOCS["ARCH-PUBLIC-001"],
    })
    return
  }

  if (!isCapabilityPlacement(from.placement)) {
    return
  }

  if (to.retiredDir) {
    addFinding(findings, {
      ruleId: "ARCH-LAYER-002",
      fingerprint: `ARCH-LAYER-002:target-to-retired:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} is in the target capability layout and may not depend on retired layer code such as src/${edge.to}.`,
      remediation:
        "Keep capability code in public/, application/, domain/, and infrastructure/ instead of routing dependencies through retired directories.",
      doc: RULE_DOCS["ARCH-LAYER-002"],
    })
    return
  }

  if (!isCapabilityPlacement(to.placement)) {
    return
  }

  if (from.placement === to.placement) {
    return
  }

  if (isInfrastructureAdapter(from) && to.placement === "application") {
    addFinding(findings, {
      ruleId: "INV-BOUNDARY-003",
      fingerprint: `INV-BOUNDARY-003:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} is an adapter subrole file and may not depend on application workflow file src/${edge.to}.`,
      remediation:
        "Import a precise application/ports contract instead of a mixed application barrel or workflow implementation, and keep runtime assembly outside infrastructure/adapters/.",
      doc: RULE_DOCS["INV-BOUNDARY-003"],
    })
    return
  }

  const allowedTargets = CAPABILITY_ALLOWED_INTERNAL_IMPORTS[from.placement]
  if (!allowedTargets.has(to.placement)) {
    addFinding(findings, {
      ruleId: "ARCH-LAYER-002",
      fingerprint: `ARCH-LAYER-002:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not depend on src/${edge.to} inside a capability module.`,
      remediation:
        "Follow the capability-module dependency directions from docs/ARCHITECTURE.md and route the dependency through the next legal layer.",
      doc: RULE_DOCS["ARCH-LAYER-002"],
    })
  }
}

function validateCoordinatorEdge(
  findings: Map<string, StructureFinding>,
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  if (isRetiredPublicBridgeEdge(edge, from, to)) {
    addFinding(findings, {
      ruleId: "ARCH-PUBLIC-001",
      fingerprint: `ARCH-PUBLIC-001:retired-ladder:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} re-exports through retired internal layers by referencing src/${edge.to}.`,
      remediation:
        "Move the coordinator public surface to public/ and stop tunneling exports through retired runtime/service/repo-style files.",
      doc: RULE_DOCS["ARCH-PUBLIC-001"],
    })
    return
  }

  if (!isCoordinatorPlacement(from.placement)) {
    return
  }

  if (to.retiredDir) {
    addFinding(findings, {
      ruleId: "ARCH-LAYER-002",
      fingerprint: `ARCH-LAYER-002:target-to-retired:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} is in the target coordinator layout and may not depend on retired layer code such as src/${edge.to}.`,
      remediation:
        "Keep coordinator code in public/, application/, and infrastructure/ instead of routing dependencies through retired directories.",
      doc: RULE_DOCS["ARCH-LAYER-002"],
    })
    return
  }

  if (!isCoordinatorPlacement(to.placement)) {
    return
  }

  if (from.placement === to.placement) {
    return
  }

  if (isInfrastructureAdapter(from) && to.placement === "application") {
    addFinding(findings, {
      ruleId: "INV-BOUNDARY-003",
      fingerprint: `INV-BOUNDARY-003:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} is an adapter subrole file and may not depend on application workflow file src/${edge.to}.`,
      remediation:
        "Import a precise application/ports contract instead of a mixed application barrel or workflow implementation, and keep runtime assembly outside infrastructure/adapters/.",
      doc: RULE_DOCS["INV-BOUNDARY-003"],
    })
    return
  }

  const allowedTargets = COORDINATOR_ALLOWED_INTERNAL_IMPORTS[from.placement]
  if (!allowedTargets.has(to.placement)) {
    addFinding(findings, {
      ruleId: "ARCH-LAYER-002",
      fingerprint: `ARCH-LAYER-002:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not depend on src/${edge.to} inside the coordinator module.`,
      remediation:
        "Follow the coordinator-module dependency directions from docs/ARCHITECTURE.md and route the dependency through the next legal layer.",
      doc: RULE_DOCS["ARCH-LAYER-002"],
    })
  }
}

function validateKernelEdge(
  findings: Map<string, StructureFinding>,
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  if (from.placement !== "contracts") {
    return
  }

  if (to.placement === "contracts") {
    return
  }

  if (to.retiredDir || to.placement === "unknown") {
    addFinding(findings, {
      ruleId: "ARCH-LAYER-002",
      fingerprint: `ARCH-LAYER-002:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not depend on src/${edge.to} inside the shared kernel.`,
      remediation:
        "Keep kernel contracts self-contained and move non-contract code out of src/kernel.",
      doc: RULE_DOCS["ARCH-LAYER-002"],
    })
  }
}

function validateCrossModuleEdge(
  findings: Map<string, StructureFinding>,
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  if (to.isFinalModule && !to.isModuleIndex) {
    addFinding(findings, {
      ruleId: "ARCH-CROSS-001",
      fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import internal file src/${edge.to} across module boundaries.`,
      remediation:
        `Import the target module only through src/${to.topLevel}/index.ts and keep cross-module deep imports out of the tree.`,
      doc: RULE_DOCS["ARCH-CROSS-001"],
    })
    return
  }

  if (!from.isFinalModule || !to.isFinalModule) {
    return
  }

  if (from.moduleKind === "shell") {
    if (from.topLevel === "bootstrap") {
      if (to.moduleKind === "shell" && to.topLevel !== "bootstrap") {
        addFinding(findings, {
          ruleId: "ARCH-CROSS-001",
          fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
          summary: `src/${edge.from} may not depend on shell module src/${edge.to} from bootstrap.`,
          remediation:
            "Keep bootstrap as the composition root for capability, coordinator, and kernel modules only; operator-facing shell behavior belongs in cli/, app-server/, or desktop/.",
          doc: RULE_DOCS["ARCH-CROSS-001"],
        })
      }

      return
    }

    if (
      (to.moduleKind === "shell" && to.topLevel === "bootstrap") ||
      to.moduleKind === "kernel"
    ) {
      return
    }

    addFinding(findings, {
      ruleId: "ARCH-CROSS-001",
      fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import src/${edge.to} from a non-bootstrap shell module.`,
      remediation:
        "Route cross-module composition through src/bootstrap/index.ts. Non-bootstrap shell modules may depend on bootstrap and kernel only, not on capability or coordinator module roots directly.",
      doc: RULE_DOCS["ARCH-CROSS-001"],
    })
    return
  }

  if (
    (from.moduleKind === "capability" || from.moduleKind === "coordinator") &&
    to.moduleKind === "kernel"
  ) {
    return
  }

  if (from.moduleKind === "capability") {
    addFinding(findings, {
      ruleId: "ARCH-CROSS-001",
      fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import src/${edge.to} across module boundaries from within a capability module.`,
      remediation:
        "Keep capability modules headless: define outbound dependencies in application/ports, inject implementations from bootstrap, and reserve kernel/index.ts for truly global contracts only.",
      doc: RULE_DOCS["ARCH-CROSS-001"],
    })
    return
  }

  if (from.moduleKind === "coordinator") {
    addFinding(findings, {
      ruleId: "ARCH-CROSS-001",
      fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import src/${edge.to} across module boundaries from within the coordinator module.`,
      remediation:
        "Keep orchestration dependent on its own application/ports, inject capability implementations from bootstrap, and reserve kernel/index.ts for truly global contracts only.",
      doc: RULE_DOCS["ARCH-CROSS-001"],
    })
    return
  }

  if (from.moduleKind === "kernel") {
    addFinding(findings, {
      ruleId: "ARCH-CROSS-001",
      fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import module-owned code such as src/${edge.to} from the shared kernel.`,
      remediation:
        "Keep kernel contracts globally stable and non-business, and move module-specific concepts back into their owning module.",
      doc: RULE_DOCS["ARCH-CROSS-001"],
    })
  }
}

function addFinding(
  findings: Map<string, StructureFinding>,
  finding: StructureFinding,
) {
  findings.set(finding.fingerprint, finding)
}

function getSourceFileMeta(relPath: string): SourceFileMeta {
  const segments = relPath.split("/")
  const topLevel = segments[0] ?? ""
  const moduleKind = getModuleKind(topLevel)
  const isModuleIndex = segments.length === 2 && segments[1] === "index.ts"
  const primaryDir = !isModuleIndex ? (segments[1] ?? null) : null
  const secondaryDir = !isModuleIndex ? (segments[2] ?? null) : null
  const retiredDir =
    primaryDir && RETIRED_INTERNAL_DIRECTORIES.has(primaryDir) ? primaryDir : null

  return {
    relPath,
    topLevel,
    moduleKind,
    primaryDir,
    secondaryDir,
    retiredDir,
    isModuleIndex,
    isFinalModule: isFinalModuleKind(moduleKind),
    placement: getSourcePlacement(moduleKind, isModuleIndex, primaryDir, secondaryDir, retiredDir),
  }
}

function getModuleKind(topLevel: string): ModuleKind {
  if (FINAL_CAPABILITY_TOP_LEVELS.has(topLevel)) {
    return "capability"
  }

  if (FINAL_COORDINATOR_TOP_LEVELS.has(topLevel)) {
    return "coordinator"
  }

  if (FINAL_SHELL_TOP_LEVELS.has(topLevel)) {
    return "shell"
  }

  if (FINAL_KERNEL_TOP_LEVELS.has(topLevel)) {
    return "kernel"
  }

  return "unknown"
}

function getSourcePlacement(
  moduleKind: ModuleKind,
  isModuleIndex: boolean,
  primaryDir: string | null,
  secondaryDir: string | null,
  retiredDir: string | null,
): SourcePlacement {
  if (isModuleIndex) {
    return "module-index"
  }

  if (retiredDir) {
    return "retired"
  }

  if (moduleKind === "capability") {
    if (primaryDir === "public") {
      return "public"
    }

    if (primaryDir === "application" && secondaryDir === "ports") {
      return "application-port"
    }

    if (primaryDir === "application") {
      return "application"
    }

    if (primaryDir === "domain") {
      return "domain"
    }

    if (primaryDir === "infrastructure") {
      return "infrastructure"
    }
  }

  if (moduleKind === "coordinator") {
    if (primaryDir === "public") {
      return "public"
    }

    if (primaryDir === "application" && secondaryDir === "ports") {
      return "application-port"
    }

    if (primaryDir === "application") {
      return "application"
    }

    if (primaryDir === "infrastructure") {
      return "infrastructure"
    }
  }

  if (moduleKind === "kernel" && primaryDir === "contracts") {
    return "contracts"
  }

  if (moduleKind === "shell") {
    return "shell-internal"
  }

  return "unknown"
}

function isFinalModuleKind(moduleKind: ModuleKind) {
  return (
    moduleKind === "capability" ||
    moduleKind === "coordinator" ||
    moduleKind === "shell" ||
    moduleKind === "kernel"
  )
}

function requiresModuleIndex(moduleKind: ModuleKind) {
  return (
    moduleKind === "capability" ||
    moduleKind === "coordinator" ||
    moduleKind === "shell" ||
    moduleKind === "kernel"
  )
}

function protectsOwnModuleRoot(moduleKind: ModuleKind) {
  return (
    moduleKind === "capability" ||
    moduleKind === "coordinator" ||
    moduleKind === "kernel"
  )
}

function isCapabilityPlacement(
  placement: SourcePlacement,
): placement is CapabilityPlacement {
  return (
    placement === "public" ||
    placement === "application" ||
    placement === "application-port" ||
    placement === "domain" ||
    placement === "infrastructure"
  )
}

function isCoordinatorPlacement(
  placement: SourcePlacement,
): placement is CoordinatorPlacement {
  return (
    placement === "public" ||
    placement === "application" ||
    placement === "application-port" ||
    placement === "infrastructure"
  )
}

function isInfrastructureAdapter(meta: SourceFileMeta) {
  return (
    meta.primaryDir === "infrastructure" &&
    meta.secondaryDir === "adapters"
  )
}

function isRetiredPublicBridgeEdge(
  edge: ImportEdge,
  from: SourceFileMeta,
  to: SourceFileMeta,
) {
  return (
    edge.kind === "export" &&
    from.retiredDir != null &&
    to.retiredDir != null &&
    from.retiredDir !== to.retiredDir &&
    isRetiredPublicBridgeSource(from)
  )
}

function isRetiredPublicBridgeSource(meta: SourceFileMeta) {
  const fileName = basename(meta.relPath)

  return (
    (meta.retiredDir === "runtime" && fileName === "api.ts") ||
    (meta.retiredDir === "service" && fileName === "index.ts")
  )
}

function extractImportStatements(source: string) {
  const statements: Array<{ kind: EdgeKind; specifier: string }> = []

  for (const match of source.matchAll(IMPORT_EXPORT_PATTERN)) {
    const kind = match[1]
    const specifier = match[2]

    if ((kind === "import" || kind === "export") && specifier) {
      statements.push({
        kind,
        specifier,
      })
    }
  }

  return statements
}

function resolveLocalImport(
  fromRelPath: string,
  specifier: string,
  knownFiles: Set<string>,
) {
  if (specifier.startsWith(".")) {
    return resolveKnownFile(
      normalize(join(dirname(fromRelPath), specifier)).replaceAll("\\", "/"),
      knownFiles,
    )
  }

  if (specifier.startsWith("src/")) {
    return resolveKnownFile(specifier.slice("src/".length), knownFiles)
  }

  if (specifier.startsWith("@/")) {
    return resolveKnownFile(specifier.slice(2), knownFiles)
  }

  return null
}

function resolveKnownFile(normalizedBase: string, knownFiles: Set<string>) {
  const candidates = [normalizedBase, `${normalizedBase}.ts`, `${normalizedBase}/index.ts`]

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate
    }
  }

  return null
}

function collectModuleState(graph: RepositoryGraph) {
  const state = new Map<string, ModuleState>()

  for (const directory of graph.directories) {
    const moduleKind = getModuleKind(directory)
    if (
      moduleKind !== "capability" &&
      moduleKind !== "coordinator" &&
      moduleKind !== "shell" &&
      moduleKind !== "kernel"
    ) {
      continue
    }

    state.set(directory, {
      hasIndex: false,
      primaryDirs: new Set<string>(),
    })
  }

  for (const file of graph.files) {
    const meta = getSourceFileMeta(file)
    const module = state.get(meta.topLevel)
    if (!module) {
      continue
    }

    if (meta.isModuleIndex) {
      module.hasIndex = true
      continue
    }

    if (meta.primaryDir) {
      module.primaryDirs.add(meta.primaryDir)
    }
  }

  return state
}

async function listTopLevelDirectories(root: string) {
  const entries = await readdir(root, {
    withFileTypes: true,
  })

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function listTypeScriptFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = prefix ? join(root, prefix) : root
  const entries = await readdir(directory, {
    withFileTypes: true,
  })
  const files: string[] = []

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(root, relPath)))
      continue
    }

    if (entry.isFile() && relPath.endsWith(".ts")) {
      files.push(relPath)
    }
  }

  return files.sort()
}
