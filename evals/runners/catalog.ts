import { readdir, readFile } from "node:fs/promises"
import { isAbsolute, resolve, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { EvalTaskSchema, type EvalProviderMode, type EvalTask } from "../schemas/task"

const EvalTaskDocumentSchema = EvalTaskSchema.omit({
  workspaceRoot: true,
}).extend({
  workspaceFixture: z.string().min(1),
})

export type DiscoveredEvalTask = EvalTask

export function getEvalsRoot() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)))
}

export function getDefaultEvalTasksRoot() {
  return join(getEvalsRoot(), "tasks")
}

export function getDefaultEvalFixturesRoot() {
  return join(getEvalsRoot(), "fixtures")
}

export function getDefaultEvalOutputRoot(cwd: string = process.cwd()) {
  return join(cwd, ".ncoworker", "evals")
}

export async function loadEvalTasks(input: {
  tasksRoot?: string
  providerMode?: EvalProviderMode
} = {}): Promise<DiscoveredEvalTask[]> {
  const tasksRoot = input.tasksRoot ?? getDefaultEvalTasksRoot()
  const providerMode = input.providerMode ?? "scripted"
  const taskFiles = await listTaskFiles(tasksRoot)
  const tasks: DiscoveredEvalTask[] = []

  for (const taskFile of taskFiles) {
    const documentText = await readFile(taskFile, "utf8")

    if (!shouldLoadTaskFile(documentText, taskFile, tasksRoot, providerMode)) {
      continue
    }

    const parsed = EvalTaskDocumentSchema.parse(JSON.parse(documentText))
    const task = EvalTaskSchema.parse({
      ...parsed,
      scenario: parsed.scenario,
      workspaceRoot: resolveEvalFixturePath(parsed.workspaceFixture),
    }) as DiscoveredEvalTask

    if (task.providerMode === providerMode) {
      tasks.push(task)
    }
  }

  return tasks.sort((left, right) => left.id.localeCompare(right.id))
}

async function listTaskFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, {
    withFileTypes: true,
  })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(root, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await listTaskFiles(path)))
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path)
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
}

function shouldLoadTaskFile(
  documentText: string,
  taskFile: string,
  tasksRoot: string,
  providerMode: EvalProviderMode,
) {
  return inferTaskProviderMode(documentText, taskFile, tasksRoot) === providerMode
}

function inferTaskProviderMode(
  documentText: string,
  taskFile: string,
  tasksRoot: string,
): EvalProviderMode {
  const relativePath = taskFile.slice(`${resolve(tasksRoot)}${sep}`.length)
  const topLevelDirectory = relativePath.split(sep, 1)[0]

  if (topLevelDirectory === "live") {
    return "live"
  }

  return /"providerMode"\s*:\s*"live"/.test(documentText) ? "live" : "scripted"
}

function resolveEvalFixturePath(workspaceFixture: string) {
  if (isAbsolute(workspaceFixture)) {
    throw new Error("Eval workspaceFixture must be relative to evals/fixtures")
  }

  const fixturesRoot = resolve(getDefaultEvalFixturesRoot())
  const fixturePath = resolve(fixturesRoot, workspaceFixture)

  if (fixturePath !== fixturesRoot && !fixturePath.startsWith(`${fixturesRoot}${sep}`)) {
    throw new Error(`Eval workspaceFixture must stay inside ${fixturesRoot}`)
  }

  return fixturePath
}
