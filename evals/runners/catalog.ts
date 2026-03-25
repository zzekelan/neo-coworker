import { readdir, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { EvalTaskSchema, type EvalTask } from "../schemas/task"

const EvalTaskDocumentSchema = EvalTaskSchema.omit({
  workspaceRoot: true,
  scenario: true,
}).extend({
  scenario: z.string().min(1),
  workspaceFixture: z.string().min(1),
})

export type DiscoveredEvalTask = EvalTask & {
  scenario: string
}

export function getEvalsRoot() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)))
}

export function getDefaultEvalTasksRoot() {
  return join(getEvalsRoot(), "tasks")
}

export function getDefaultEvalOutputRoot(cwd: string = process.cwd()) {
  return join(cwd, ".agents", "evals")
}

export async function loadEvalTasks(input: {
  tasksRoot?: string
} = {}): Promise<DiscoveredEvalTask[]> {
  const tasksRoot = input.tasksRoot ?? getDefaultEvalTasksRoot()
  const taskFiles = await listTaskFiles(tasksRoot)
  const tasks = await Promise.all(
    taskFiles.map(async (taskFile) => {
      const parsed = EvalTaskDocumentSchema.parse(JSON.parse(await readFile(taskFile, "utf8")))

      return EvalTaskSchema.parse({
        ...parsed,
        scenario: parsed.scenario,
        workspaceRoot: resolve(getEvalsRoot(), parsed.workspaceFixture),
      }) as DiscoveredEvalTask
    }),
  )

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
