import { readdir, readFile } from "node:fs/promises"
import { dirname, join, normalize } from "node:path"

export const SOURCE_ROOT = join(process.cwd(), "src")
export const STRUCTURE_BASELINE_PATH = join(
  process.cwd(),
  "test",
  "structure",
  "baselines",
  "architecture-findings.json",
)
export const CORE_TOP_LEVELS = new Set([
  "conversation",
  "model",
  "orchestration",
  "permission",
  "tool",
])
export const OUTER_SHELL_TOP_LEVELS = new Set([
  "wiring",
  "cli",
  "server",
  "app-server",
  "bootstrap",
])
export const ALLOWED_TOP_LEVELS = new Set([
  ...CORE_TOP_LEVELS,
  ...OUTER_SHELL_TOP_LEVELS,
])
export const LEGACY_TOP_LEVELS = new Set(["providers", "runtime"])
export const APPROVED_DOMAIN_LAYERS = new Set([
  "types",
  "config",
  "repo",
  "ports",
  "service",
  "runtime",
])

const REQUIRED_DOMAIN_LAYERS = ["types", "config", "repo", "ports", "service", "runtime"] as const
const ALLOWED_INTERNAL_IMPORTS = {
  types: new Set<string>(),
  config: new Set(["types"]),
  repo: new Set(["config"]),
  ports: new Set<string>(),
  service: new Set(["repo", "ports"]),
  runtime: new Set(["service"]),
} as const
const IMPORT_PATTERN = /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g
const RULE_DOCS = {
  "ARCH-TOPLEVEL-001": "docs/ARCHITECTURE.md#top-level-map",
  "ARCH-LAYER-001": "docs/ARCHITECTURE.md#domain-layers",
  "ARCH-CROSS-001": "docs/ARCHITECTURE.md#cross-domain-boundaries",
  "INV-STRUCTURE-001":
    "docs/dev/QUALITY_INVARIANTS.md#inv-structure-001-approved-domain-layer-names",
} as const

export type StructureRuleId =
  | "ARCH-TOPLEVEL-001"
  | "ARCH-LAYER-001"
  | "ARCH-CROSS-001"
  | "INV-STRUCTURE-001"

export type ImportEdge = {
  from: string
  to: string
  specifier: string
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

type SourceFileMeta = {
  relPath: string
  topLevel: string
  layer: string | null
  isCoreDomain: boolean
  isOuterShell: boolean
  isDomainIndex: boolean
}

type DomainState = {
  hasIndex: boolean
  layers: Set<string>
}

export async function loadRepositoryGraph(): Promise<RepositoryGraph> {
  const directories = await listTopLevelDirectories(SOURCE_ROOT)
  const files = await listTypeScriptFiles(SOURCE_ROOT)
  const fileSet = new Set(files)
  const edges: ImportEdge[] = []

  for (const file of files) {
    const source = await readFile(join(SOURCE_ROOT, file), "utf8")

    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveLocalImport(file, specifier, fileSet)
      if (!resolved) {
        continue
      }

      edges.push({
        from: file,
        to: resolved,
        specifier,
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
  const domainState = collectDomainState(graph)

  for (const directory of graph.directories) {
    if (LEGACY_TOP_LEVELS.has(directory)) {
      addFinding(findings, {
        ruleId: "ARCH-TOPLEVEL-001",
        fingerprint: `ARCH-TOPLEVEL-001:top-level:${directory}`,
        summary: `src/${directory} is a legacy top-level directory and must not reappear.`,
        remediation:
          "Move the code into one of the approved business domains or into an approved outer-shell top-level.",
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
          "Place the code under an approved core domain or an approved outer-shell top-level, or update docs/ARCHITECTURE.md and the structure checks in the same change.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
    }
  }

  for (const domain of graph.directories.filter((directory) => CORE_TOP_LEVELS.has(directory))) {
    const state = domainState.get(domain)

    if (!state?.hasIndex) {
      addFinding(findings, {
        ruleId: "ARCH-LAYER-001",
        fingerprint: `ARCH-LAYER-001:missing-index:${domain}`,
        summary: `src/${domain} is missing its required root index.ts public entrypoint.`,
        remediation:
          `Add src/${domain}/index.ts as the domain's public exit and route outer-shell composition through that file.`,
        doc: RULE_DOCS["ARCH-LAYER-001"],
      })
    }

    for (const layer of REQUIRED_DOMAIN_LAYERS) {
      if (state?.layers.has(layer)) {
        continue
      }

      addFinding(findings, {
        ruleId: "ARCH-LAYER-001",
        fingerprint: `ARCH-LAYER-001:missing-layer:${domain}/${layer}`,
        summary: `src/${domain} is missing its required ${layer}/ layer.`,
        remediation:
          `Add src/${domain}/${layer}/ and move the domain code into the fixed layer skeleton instead of inventing a domain-specific shape.`,
        doc: RULE_DOCS["ARCH-LAYER-001"],
      })
    }
  }

  for (const file of graph.files) {
    const meta = getSourceFileMeta(file)
    if (!meta.isCoreDomain || meta.isDomainIndex) {
      continue
    }

    if (meta.layer == null || !APPROVED_DOMAIN_LAYERS.has(meta.layer)) {
      addFinding(findings, {
        ruleId: "INV-STRUCTURE-001",
        fingerprint: `INV-STRUCTURE-001:file:${file}`,
        summary: `src/${file} uses unsupported layer directory "${meta.layer ?? "(missing)"}".`,
        remediation:
          meta.layer === "wiring"
            ? "Move the code into an approved domain layer or relocate true composition code into an outer-shell top-level such as src/wiring/*, src/cli/*, src/server/*, src/app-server/*, or src/bootstrap/*."
            : "Move the file into one of: types, config, repo, ports, service, runtime, or the domain root index.ts.",
        doc: RULE_DOCS["INV-STRUCTURE-001"],
      })
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
        summary: `src/${edge.from} imports src/${edge.to}, which is outside the approved top-level modules.`,
        remediation:
          "Import only from approved core domains or outer-shell top-levels, or move the target under an approved top-level module.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
      continue
    }

    if (from.topLevel === to.topLevel) {
      if (from.isOuterShell || from.isDomainIndex || to.isDomainIndex) {
        continue
      }

      if (!isImportCheckedDomainLayer(from.layer) || !isImportCheckedDomainLayer(to.layer)) {
        continue
      }

      const isSameLayer = from.layer === to.layer
      const allowedLayers =
        ALLOWED_INTERNAL_IMPORTS[from.layer as keyof typeof ALLOWED_INTERNAL_IMPORTS]
      if (!isSameLayer && !allowedLayers?.has(to.layer)) {
        addFinding(findings, {
          ruleId: "ARCH-LAYER-001",
          fingerprint: `ARCH-LAYER-001:edge:${edge.from}->${edge.to}`,
          summary: `src/${edge.from} may not import src/${edge.to} inside the same domain.`,
          remediation:
            "Follow the fixed layer direction from docs/ARCHITECTURE.md and route the dependency through the next legal layer.",
          doc: RULE_DOCS["ARCH-LAYER-001"],
        })
      }
      continue
    }

    if (from.isOuterShell) {
      if (to.isCoreDomain && !to.isDomainIndex) {
        addFinding(findings, {
          ruleId: "ARCH-CROSS-001",
          fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
          summary: `src/${edge.from} may only import a domain through its root index.ts, but imports src/${edge.to}.`,
          remediation:
            "Import the target domain through src/<domain>/index.ts instead of reaching into its internal layers from the outer shell.",
          doc: RULE_DOCS["ARCH-CROSS-001"],
        })
      }
      continue
    }

    if (from.isCoreDomain && to.isOuterShell) {
      addFinding(findings, {
        ruleId: "ARCH-CROSS-001",
        fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
        summary: `src/${edge.from} may not depend on outer-shell code such as src/${edge.to}.`,
        remediation:
          "Keep domains headless and inject outer-shell behavior from src/wiring/* or another outer-shell top-level instead of importing it into a domain.",
        doc: RULE_DOCS["ARCH-CROSS-001"],
      })
      continue
    }

    if (from.isCoreDomain && to.isCoreDomain) {
      addFinding(findings, {
        ruleId: "ARCH-CROSS-001",
        fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
        summary: `src/${edge.from} may not import src/${edge.to} across core domains.`,
        remediation:
          "Define the external capability in the importing domain's ports/, inject the target domain from an outer-shell top-level, and keep cross-domain imports out of the domains themselves.",
        doc: RULE_DOCS["ARCH-CROSS-001"],
      })
    }
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

function addFinding(
  findings: Map<string, StructureFinding>,
  finding: StructureFinding,
) {
  findings.set(finding.fingerprint, finding)
}

function getSourceFileMeta(relPath: string): SourceFileMeta {
  const segments = relPath.split("/")
  const topLevel = segments[0] ?? ""
  const isCoreDomain = CORE_TOP_LEVELS.has(topLevel)
  const isOuterShell = OUTER_SHELL_TOP_LEVELS.has(topLevel)
  const isDomainIndex = isCoreDomain && segments.length === 2 && segments[1] === "index.ts"
  const layer = isCoreDomain && !isDomainIndex ? (segments[1] ?? null) : null

  return {
    relPath,
    topLevel,
    layer,
    isCoreDomain,
    isOuterShell,
    isDomainIndex,
  }
}

function isImportCheckedDomainLayer(
  layer: string | null,
): layer is keyof typeof ALLOWED_INTERNAL_IMPORTS {
  return (
    layer === "types" ||
    layer === "config" ||
    layer === "repo" ||
    layer === "ports" ||
    layer === "service" ||
    layer === "runtime"
  )
}

function extractImportSpecifiers(source: string) {
  const specifiers: string[] = []

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1]
    if (!specifier) {
      continue
    }

    specifiers.push(specifier)
  }

  return specifiers
}

function resolveLocalImport(
  fromRelPath: string,
  specifier: string,
  knownFiles: Set<string>,
) {
  if (specifier.startsWith(".")) {
    return resolveKnownFile(normalize(join(dirname(fromRelPath), specifier)).replaceAll("\\", "/"), knownFiles)
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
  const candidates = [
    normalizedBase,
    `${normalizedBase}.ts`,
    `${normalizedBase}/index.ts`,
  ]

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) {
      return candidate
    }
  }

  return null
}

function collectDomainState(graph: RepositoryGraph) {
  const state = new Map<string, DomainState>()

  for (const domain of graph.directories.filter((directory) => CORE_TOP_LEVELS.has(directory))) {
    state.set(domain, {
      hasIndex: false,
      layers: new Set<string>(),
    })
  }

  for (const file of graph.files) {
    const meta = getSourceFileMeta(file)
    if (!meta.isCoreDomain) {
      continue
    }

    const domain = state.get(meta.topLevel)
    if (!domain) {
      continue
    }

    if (meta.isDomainIndex) {
      domain.hasIndex = true
      continue
    }

    if (meta.layer) {
      domain.layers.add(meta.layer)
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
