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
export const ALLOWED_TOP_LEVELS = new Set([
  "conversation",
  "model",
  "orchestration",
  "permission",
  "tool",
  "wiring",
])
export const LEGACY_TOP_LEVELS = new Set(["providers", "runtime", "server", "cli"])
export const ALLOWED_DOMAIN_LAYERS = new Set([
  "types",
  "config",
  "repo",
  "ports",
  "service",
  "runtime",
  "wiring",
])

const ALLOWED_INTERNAL_IMPORTS = {
  config: new Set(["types"]),
  repo: new Set(["config"]),
  service: new Set(["repo", "ports"]),
  runtime: new Set(["service"]),
  wiring: new Set(["runtime", "ports"]),
} as const
const IMPORT_PATTERN = /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g
const RULE_DOCS = {
  "ARCH-TOPLEVEL-001": "ARCHITECTURE.md#top-level-map",
  "ARCH-LAYER-001": "ARCHITECTURE.md#domain-layers",
  "ARCH-CROSS-001": "ARCHITECTURE.md#cross-domain-boundaries",
  "INV-STRUCTURE-001":
    "QUALITY_INVARIANTS.md#inv-structure-001-approved-domain-layer-names",
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
}

export async function loadRepositoryGraph(): Promise<RepositoryGraph> {
  const directories = await listTopLevelDirectories(SOURCE_ROOT)
  const files = await listTypeScriptFiles(SOURCE_ROOT)
  const fileSet = new Set(files)
  const edges: ImportEdge[] = []

  for (const file of files) {
    const source = await readFile(join(SOURCE_ROOT, file), "utf8")

    for (const specifier of extractRelativeImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, specifier, fileSet)
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

  for (const directory of graph.directories) {
    if (LEGACY_TOP_LEVELS.has(directory)) {
      addFinding(findings, {
        ruleId: "ARCH-TOPLEVEL-001",
        fingerprint: `ARCH-TOPLEVEL-001:top-level:${directory}`,
        summary: `src/${directory} is a legacy top-level directory and must not reappear.`,
        remediation:
          "Move the code into one of the approved business domains or into src/wiring/*.",
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
          "Place the code under an approved domain or update ARCHITECTURE.md and the structure checks in the same change.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
    }
  }

  for (const file of graph.files) {
    const meta = getSourceFileMeta(file)
    if (!ALLOWED_TOP_LEVELS.has(meta.topLevel) || meta.topLevel === "wiring") {
      continue
    }

    if (meta.layer == null || !ALLOWED_DOMAIN_LAYERS.has(meta.layer)) {
      addFinding(findings, {
        ruleId: "INV-STRUCTURE-001",
        fingerprint: `INV-STRUCTURE-001:file:${file}`,
        summary: `src/${file} uses unsupported layer directory "${meta.layer ?? "(missing)"}".`,
        remediation:
          "Move the file into one of: types, config, repo, ports, service, runtime, wiring.",
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
          "Import only from approved domains or move the target under an approved top-level module.",
        doc: RULE_DOCS["ARCH-TOPLEVEL-001"],
      })
      continue
    }

    if (from.topLevel === to.topLevel) {
      if (from.topLevel === "wiring") {
        continue
      }

      if (!isAllowedDomainLayer(from.layer) || !isAllowedDomainLayer(to.layer)) {
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
            "Follow the allowed layer direction from ARCHITECTURE.md and route the dependency through the next legal layer.",
          doc: RULE_DOCS["ARCH-LAYER-001"],
        })
      }
      continue
    }

    if (from.topLevel === "wiring") {
      if (to.layer !== "wiring") {
        addFinding(findings, {
          ruleId: "ARCH-CROSS-001",
          fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
          summary: `src/${edge.from} may only import domain wiring entrypoints, but imports src/${edge.to}.`,
          remediation:
            "Import the target domain's wiring entrypoint instead of reaching into its internals from src/wiring/*.",
          doc: RULE_DOCS["ARCH-CROSS-001"],
        })
      }
      continue
    }

    if (!isAllowedDomainLayer(from.layer) || !isAllowedDomainLayer(to.layer)) {
      continue
    }

    if (from.layer === "wiring") {
      if (to.layer !== "ports") {
        addFinding(findings, {
          ruleId: "ARCH-CROSS-001",
          fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
          summary: `src/${edge.from} may only cross domains through ports, but imports src/${edge.to}.`,
          remediation:
            "Depend on the target domain's ports contract or move the composition to src/wiring/*.",
          doc: RULE_DOCS["ARCH-CROSS-001"],
        })
      }
      continue
    }

    addFinding(findings, {
      ruleId: "ARCH-CROSS-001",
      fingerprint: `ARCH-CROSS-001:edge:${edge.from}->${edge.to}`,
      summary: `src/${edge.from} may not import src/${edge.to} across domains outside wiring.`,
      remediation:
        "Keep cross-domain calls behind ports and wiring instead of importing another domain directly.",
      doc: RULE_DOCS["ARCH-CROSS-001"],
    })
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
  const layer = topLevel === "wiring" ? "wiring" : (segments[1] ?? null)

  return {
    relPath,
    topLevel,
    layer,
  }
}

function isAllowedDomainLayer(layer: string | null): layer is keyof typeof ALLOWED_INTERNAL_IMPORTS {
  return (
    layer === "config" ||
    layer === "repo" ||
    layer === "service" ||
    layer === "runtime" ||
    layer === "wiring"
  )
}

function extractRelativeImportSpecifiers(source: string) {
  const specifiers: string[] = []

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1]
    if (!specifier?.startsWith(".")) {
      continue
    }

    specifiers.push(specifier)
  }

  return specifiers
}

function resolveRelativeImport(
  fromRelPath: string,
  specifier: string,
  knownFiles: Set<string>,
) {
  const normalizedBase = normalize(join(dirname(fromRelPath), specifier)).replaceAll("\\", "/")
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
