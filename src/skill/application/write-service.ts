import {
  LEGACY_SKILLS_DIRECTORY,
  SKILLS_DIRECTORY,
  SKILL_FILENAME,
} from "../domain"
import type { LoadedSkill, SkillStore } from "./ports/store"

const MAX_SKILL_SEGMENT_LENGTH = 64
const MAX_SKILL_DESCRIPTION_LENGTH = 1024
const VALID_SKILL_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/
const SKILL_METADATA_LINE_RE = /^[a-zA-Z0-9_-]+\s*:\s*.*$/

type SkillOperation = "create" | "patch"

export class SkillWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class SkillValidationError extends SkillWriteError {}

export class SkillPathTraversalError extends SkillValidationError {}

export class SkillAlreadyExistsError extends SkillWriteError {}

export class SkillNotFoundError extends SkillWriteError {}

export type SkillObserverEvent = {
  sessionId: string
  runId: string
  type: "skill.created" | "skill.patched" | "skill.deleted" | "skill.security_scan"
  payload: Record<string, unknown>
}

export type SkillObserverPort = {
  recordSkillEvent?(event: SkillObserverEvent): void | Promise<void>
}

export type SkillSecurityScanInput = {
  workspaceRoot: string
  category?: string
  name: string
  skillPath: string
  operation: SkillOperation
  content: string
}

export type SkillSecurityScanPort = {
  scanBeforeWrite?(input: SkillSecurityScanInput): void | Promise<void>
}

export type CreateSkillWriteServiceInput = {
  store: SkillStore
  skillObserver?: SkillObserverPort
  observerContext?: {
    sessionId: string
    runId: string
  }
  securityScan?: SkillSecurityScanPort
}

export function createSkillWriteService(input: CreateSkillWriteServiceInput) {
  return {
    async createSkill(inputValue: {
      workspaceRoot: string
      category?: string
      name: string
      content: string
      frontmatter: Record<string, unknown>
    }) {
      const category = normalizeCategory(inputValue.category)
      const name = normalizeSkillName(inputValue.name)
      const content = normalizeSkillBody(inputValue.content, "Skill content cannot be empty.")
      const frontmatter = normalizeFrontmatter(inputValue.frontmatter, name)
      const skillPath = buildSkillPath(SKILLS_DIRECTORY, category, name)

      await ensureSkillDoesNotExist(input.store, inputValue.workspaceRoot, category, name)

      const rendered = renderSkillDocument(frontmatter, content)
      await runSecurityScan(input, {
        workspaceRoot: inputValue.workspaceRoot,
        category,
        name,
        skillPath,
        operation: "create",
        content: rendered,
      })
      await input.store.writeSkill(inputValue.workspaceRoot, skillPath, rendered)
      await observeSkillEvent(input, {
        type: "skill.created",
        payload: {
          category: category ?? null,
          name,
          contentLength: content.length,
        },
      })
    },
    async patchSkill(inputValue: {
      workspaceRoot: string
      category?: string
      name: string
      patch: string
    }) {
      const category = normalizeCategory(inputValue.category)
      const name = normalizeSkillName(inputValue.name)
      const patch = normalizeSkillBody(inputValue.patch, "Skill patch cannot be empty.")
      const existing = await resolveExistingSkill(input.store, inputValue.workspaceRoot, category, name)
      const rendered = rewriteSkillDocument(existing.skill.instructions, patch)

      await runSecurityScan(input, {
        workspaceRoot: inputValue.workspaceRoot,
        category,
        name,
        skillPath: existing.skillPath,
        operation: "patch",
        content: rendered,
      })
      await input.store.writeSkill(inputValue.workspaceRoot, existing.skillPath, rendered)
      await observeSkillEvent(input, {
        type: "skill.patched",
        payload: {
          category: category ?? null,
          name,
          patchLength: patch.length,
        },
      })
    },
    async deleteSkill(inputValue: {
      workspaceRoot: string
      category?: string
      name: string
    }) {
      const category = normalizeCategory(inputValue.category)
      const name = normalizeSkillName(inputValue.name)
      const existing = await resolveExistingSkill(input.store, inputValue.workspaceRoot, category, name)

      await input.store.deleteSkill(inputValue.workspaceRoot, existing.skillPath)
      await observeSkillEvent(input, {
        type: "skill.deleted",
        payload: {
          category: category ?? null,
          name,
        },
      })
    },
  }
}

export type SkillWriteService = ReturnType<typeof createSkillWriteService>

async function ensureSkillDoesNotExist(
  store: SkillStore,
  workspaceRoot: string,
  category: string | undefined,
  name: string,
) {
  for (const skillPath of getSkillPathCandidates(category, name)) {
    try {
      await store.loadByPath(workspaceRoot, skillPath)
      throw new SkillAlreadyExistsError(
        `A skill named '${name}' already exists at ${skillPath}.`,
      )
    } catch (error) {
      if (error instanceof SkillAlreadyExistsError) {
        throw error
      }

      if (isMissingSkillError(error)) {
        continue
      }

      throw error
    }
  }
}

async function resolveExistingSkill(
  store: SkillStore,
  workspaceRoot: string,
  category: string | undefined,
  name: string,
): Promise<{ skillPath: string; skill: LoadedSkill }> {
  for (const skillPath of getSkillPathCandidates(category, name)) {
    try {
      return {
        skillPath,
        skill: await store.loadByPath(workspaceRoot, skillPath),
      }
    } catch (error) {
      if (isMissingSkillError(error)) {
        continue
      }

      throw error
    }
  }

  throw new SkillNotFoundError(
    category
      ? `Skill '${name}' not found in category '${category}'.`
      : `Skill '${name}' not found.`,
  )
}

function getSkillPathCandidates(category: string | undefined, name: string) {
  return [
    buildSkillPath(SKILLS_DIRECTORY, category, name),
    buildSkillPath(LEGACY_SKILLS_DIRECTORY, category, name),
  ]
}

function buildSkillPath(skillsDirectory: string, category: string | undefined, name: string) {
  return category
    ? `${skillsDirectory}/${category}/${name}/${SKILL_FILENAME}`
    : `${skillsDirectory}/${name}/${SKILL_FILENAME}`
}

function normalizeSkillName(name: string) {
  return normalizeSkillSegment(name, "Skill name")
}

function normalizeCategory(category?: string) {
  if (category === undefined) {
    return undefined
  }

  const trimmed = category.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  return normalizeSkillSegment(trimmed, "Category")
}

function normalizeSkillSegment(value: string, label: string) {
  const normalized = value.trim()

  if (normalized.length === 0) {
    throw new SkillValidationError(`${label} is required.`)
  }

  if (hasPathTraversal(normalized)) {
    throw new SkillPathTraversalError(
      `${label} must not contain path traversal or path separators.`,
    )
  }

  if (normalized.length > MAX_SKILL_SEGMENT_LENGTH) {
    throw new SkillValidationError(
      `${label} exceeds ${MAX_SKILL_SEGMENT_LENGTH} characters.`,
    )
  }

  if (!VALID_SKILL_SEGMENT_RE.test(normalized)) {
    throw new SkillValidationError(
      `Invalid ${label.toLowerCase()} '${normalized}'. Use lowercase letters, numbers, hyphens, dots, and underscores. Must start with a letter or digit.`,
    )
  }

  return normalized
}

function hasPathTraversal(value: string) {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
  )
}

function normalizeSkillBody(content: string, message: string) {
  const normalized = content.replace(/\r\n/g, "\n").trim()

  if (normalized.length === 0) {
    throw new SkillValidationError(message)
  }

  return normalized
}

function normalizeFrontmatter(frontmatter: Record<string, unknown>, name: string) {
  if (Array.isArray(frontmatter) || frontmatter === null || typeof frontmatter !== "object") {
    throw new SkillValidationError("Skill frontmatter must be a record.")
  }

  const description = frontmatter.description
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new SkillValidationError(
      "Skill frontmatter must include a non-empty description.",
    )
  }

  const normalizedDescription = description.trim()
  if (normalizedDescription.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new SkillValidationError(
      `Skill description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
    )
  }

  const normalized: Record<string, unknown> = {
    name,
    description: normalizedDescription,
  }

  for (const key of Object.keys(frontmatter).sort()) {
    if (key === "name" || key === "description") {
      continue
    }

    const value = frontmatter[key]
    if (value !== undefined) {
      normalized[key] = value
    }
  }

  return normalized
}

function renderSkillDocument(frontmatter: Record<string, unknown>, body: string) {
  const frontmatterLines = Object.entries(frontmatter).map(([key, value]) => {
    return `${key}: ${serializeFrontmatterValue(value)}`
  })

  return `---\n${frontmatterLines.join("\n")}\n---\n\n${body}\n`
}

function serializeFrontmatterValue(value: unknown) {
  if (typeof value === "string") {
    return value.includes("\n") ? JSON.stringify(value) : value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  if (value === null) {
    return "null"
  }

  return JSON.stringify(value)
}

function rewriteSkillDocument(content: string, patch: string) {
  const normalized = content.replace(/\r\n/g, "\n")
  const frontmatter = extractYamlFrontmatter(normalized) ?? extractLegacyFrontmatter(normalized)

  if (!frontmatter) {
    throw new SkillValidationError("Skill document is missing supported frontmatter.")
  }

  return `${frontmatter}\n\n${patch}\n`
}

function extractYamlFrontmatter(content: string) {
  const match = content.match(/^---\n[\s\S]*?\n---(?:\n|$)/)
  if (!match) {
    return null
  }

  return match[0].replace(/\n+$/, "")
}

function extractLegacyFrontmatter(content: string) {
  const lines = content.split("\n")
  let index = 0

  while (index < lines.length && SKILL_METADATA_LINE_RE.test(lines[index]!)) {
    index += 1
  }

  if (index === 0) {
    return null
  }

  const headerLines = lines.slice(0, index)
  if (
    !headerLines.some((line) => line.startsWith("name:")) ||
    !headerLines.some((line) => line.startsWith("description:"))
  ) {
    return null
  }

  return headerLines.join("\n")
}

async function runSecurityScan(
  input: CreateSkillWriteServiceInput,
  scanInput: SkillSecurityScanInput,
) {
  await input.securityScan?.scanBeforeWrite?.(scanInput)
}

async function observeSkillEvent(
  input: CreateSkillWriteServiceInput,
  event: Omit<SkillObserverEvent, "sessionId" | "runId">,
) {
  if (!input.observerContext) {
    return
  }

  try {
    await input.skillObserver?.recordSkillEvent?.({
      sessionId: input.observerContext.sessionId,
      runId: input.observerContext.runId,
      ...event,
    })
  } catch {
  }
}

function isMissingSkillError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}
