import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runEvalTask, type EvalRunResult } from "../runner"
import {
  getDefaultEvalOutputRoot,
  loadEvalTasks,
  type DiscoveredEvalTask,
} from "./catalog"
import { createScriptedEvalProviderFactory } from "./scripted-provider"

export type EvalSuiteTaskResult = {
  task: DiscoveredEvalTask
  result: EvalRunResult
  artifactDir: string
}

export type EvalSuiteResult = {
  outputRoot: string
  results: EvalSuiteTaskResult[]
  pass: boolean
}

export async function runDiscoveredEvalTasks(input: {
  taskIds?: string[]
  tasksRoot?: string
  outputRoot?: string
  now?: () => number
} = {}): Promise<EvalSuiteResult> {
  const tasks = await loadEvalTasks({
    tasksRoot: input.tasksRoot,
  })
  const selectedTasks = selectTasks(tasks, input.taskIds)
  const outputRoot = input.outputRoot ?? join(getDefaultEvalOutputRoot(), createRunStamp())
  const results: EvalSuiteTaskResult[] = []

  await mkdir(outputRoot, { recursive: true })

  for (const task of selectedTasks) {
    const result = await runEvalTask({
      task,
      createProvider: createScriptedEvalProviderFactory(task.scenario),
      now: input.now,
    })
    const artifactDir = await persistEvalArtifacts({
      outputRoot,
      task,
      result,
    })

    results.push({
      task,
      result,
      artifactDir,
    })
  }

  return {
    outputRoot,
    results,
    pass: results.every((entry) => entry.result.pass),
  }
}

export function formatEvalTaskSummary(input: EvalSuiteTaskResult) {
  const failures = summarizeFailures(input.result)

  return [
    `eval.task ${input.task.id}`,
    `run.status ${input.result.artifact.outcome.runStatus}`,
    `grader.outcome ${formatPass(input.result.grades.outcome.pass)}`,
    `grader.protocol ${formatPass(input.result.grades.protocol.pass)}`,
    `grader.tool_policy ${formatPass(input.result.grades.toolPolicy.pass)}`,
    `grader.trace ${formatPass(input.result.grades.trace.pass)}`,
    failures ? `failure.summary ${failures}` : null,
    `artifact.dir ${input.artifactDir}`,
  ]
    .filter((line): line is string => line != null)
    .join("\n")
}

async function persistEvalArtifacts(input: {
  outputRoot: string
  task: DiscoveredEvalTask
  result: EvalRunResult
}) {
  const artifactDir = resolveTaskArtifactDirectory(input.outputRoot, input.task.id)
  await mkdir(artifactDir, { recursive: true })

  await Promise.all([
    writeJsonFile(join(artifactDir, "trace.json"), input.result.artifact.trace),
    writeJsonFile(join(artifactDir, "transcript.json"), input.result.artifact.transcript),
    writeJsonFile(join(artifactDir, "outcome.json"), input.result.artifact.outcome),
    writeJsonFile(join(artifactDir, "metrics.json"), input.result.artifact.metrics),
    writeJsonFile(join(artifactDir, "grader-results.json"), {
      pass: input.result.pass,
      grades: input.result.grades,
    }),
  ])

  return artifactDir
}

async function writeJsonFile(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function selectTasks(tasks: DiscoveredEvalTask[], taskIds: string[] | undefined) {
  if (!taskIds || taskIds.length === 0) {
    return tasks
  }

  const selected = tasks.filter((task) => taskIds.includes(task.id))
  const missingTaskIds = taskIds.filter((taskId) => !selected.some((task) => task.id === taskId))

  if (missingTaskIds.length > 0) {
    throw new Error(`Unknown eval task ids: ${missingTaskIds.join(", ")}`)
  }

  return selected
}

function summarizeFailures(result: EvalRunResult) {
  const failures: string[] = []

  if (!result.grades.outcome.pass) {
    failures.push(
      `outcome expected ${result.grades.outcome.expectedRunStatus} observed ${result.grades.outcome.observedRunStatus}`,
    )

    if (result.grades.outcome.fileFailures.length > 0) {
      failures.push(...result.grades.outcome.fileFailures)
    }
  }

  if (!result.grades.protocol.pass) {
    if (result.grades.protocol.missingRuntimeEventTypes.length > 0) {
      failures.push(
        `protocol missing ${result.grades.protocol.missingRuntimeEventTypes.join(", ")}`,
      )
    }

    if (result.grades.protocol.unexpectedRuntimeEventTypes.length > 0) {
      failures.push(
        `protocol unexpected ${result.grades.protocol.unexpectedRuntimeEventTypes.join(", ")}`,
      )
    }
  }

  if (!result.grades.toolPolicy.pass) {
    if (result.grades.toolPolicy.missingToolNames.length > 0) {
      failures.push(`tools missing ${result.grades.toolPolicy.missingToolNames.join(", ")}`)
    }

    if (result.grades.toolPolicy.unexpectedToolNames.length > 0) {
      failures.push(`tools unexpected ${result.grades.toolPolicy.unexpectedToolNames.join(", ")}`)
    }
  }

  if (!result.grades.trace.pass && result.grades.trace.missingEventTypes.length > 0) {
    failures.push(`trace missing ${result.grades.trace.missingEventTypes.join(", ")}`)
  }

  return failures.join("; ")
}

function resolveTaskArtifactDirectory(outputRoot: string, taskId: string) {
  return join(
    outputRoot,
    ...taskId.split("/").map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, "_")),
  )
}

function createRunStamp(now: Date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "T",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("")
}

function formatPass(pass: boolean) {
  return pass ? "pass" : "fail"
}
