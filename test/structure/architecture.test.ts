import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, normalize } from "node:path"

const SOURCE_ROOT = join(process.cwd(), "src")
const ALLOWED_TOP_LEVELS = new Set([
  "conversation",
  "model",
  "orchestration",
  "permission",
  "tool",
  "wiring",
])
const LEGACY_TOP_LEVELS = new Set(["providers", "runtime", "server", "cli"])
const DISALLOWED_INTERNAL_IMPORTS = {
  service: new Set(["config", "types"]),
  runtime: new Set(["repo", "ports", "config", "types"]),
  wiring: new Set(["service", "config", "types"]),
} as const
const IMPORT_PATTERN = /\b(?:import|export)\b[\s\S]*?\bfrom\s+["']([^"']+)["']/g

type ImportEdge = {
  from: string
  to: string
  specifier: string
}

type ImportGraph = {
  directories: string[]
  edges: ImportEdge[]
}

type SourceFileMeta = {
  relPath: string
  topLevel: string
  layer: string | null
}

describe("architecture structure", () => {
  test("detects a cross-domain import violation", () => {
    const violations = validateImportGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      edges: [
        {
          from: "conversation/service/query.ts",
          to: "model/runtime/api.ts",
          specifier: "../../model/runtime/api",
        },
      ],
    })

    expect(violations.join("\n")).toContain("cross-domain import")
  })

  test("detects a runtime-to-repo import violation", () => {
    const violations = validateImportGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      edges: [
        {
          from: "model/runtime/api.ts",
          to: "model/repo/index.ts",
          specifier: "../repo",
        },
      ],
    })

    expect(violations.join("\n")).toContain("runtime file may not import repo")
  })

  test("detects a wiring-to-service import violation", () => {
    const violations = validateImportGraph({
      directories: Array.from(ALLOWED_TOP_LEVELS),
      edges: [
        {
          from: "tool/wiring/provider.ts",
          to: "tool/service/index.ts",
          specifier: "../service",
        },
      ],
    })

    expect(violations.join("\n")).toContain("wiring file may not import service")
  })

  test("repository structure matches the enforced rules", async () => {
    const graph = await loadRepositoryGraph()
    const violations = validateImportGraph(graph)

    expect(violations).toEqual([])
  })
})

async function loadRepositoryGraph(): Promise<ImportGraph> {
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
    edges,
  }
}

function validateImportGraph(graph: ImportGraph) {
  const violations: string[] = []

  for (const directory of graph.directories) {
    if (LEGACY_TOP_LEVELS.has(directory)) {
      violations.push(`legacy top-level directory must be removed: src/${directory}`)
      continue
    }

    if (!ALLOWED_TOP_LEVELS.has(directory)) {
      violations.push(`unexpected top-level directory under src/: ${directory}`)
    }
  }

  for (const edge of graph.edges) {
    const from = getSourceFileMeta(edge.from)
    const to = getSourceFileMeta(edge.to)

    if (!ALLOWED_TOP_LEVELS.has(from.topLevel)) {
      continue
    }

    if (!ALLOWED_TOP_LEVELS.has(to.topLevel)) {
      violations.push(
        `unexpected import target outside allowed src/ domains: ${formatEdge(edge)}`,
      )
      continue
    }

    if (from.topLevel === to.topLevel) {
      const blockedLayers =
        DISALLOWED_INTERNAL_IMPORTS[from.layer as keyof typeof DISALLOWED_INTERNAL_IMPORTS]
      if (blockedLayers?.has(to.layer ?? "")) {
        violations.push(
          `${from.layer} file may not import ${to.layer}: ${formatEdge(edge)}`,
        )
      }
      continue
    }

    if (from.topLevel === "wiring") {
      if (to.layer !== "wiring") {
        violations.push(
          `root wiring may only import domain wiring: ${formatEdge(edge)}`,
        )
      }
      continue
    }

    if (from.layer === "wiring") {
      continue
    }

    violations.push(`cross-domain import is not allowed outside wiring: ${formatEdge(edge)}`)
  }

  return [...new Set(violations)].sort()
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

function formatEdge(edge: ImportEdge) {
  return `${edge.from} -> ${edge.to} (${edge.specifier})`
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
