import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { DefaultProviderInput } from "../../src/bootstrap"
import { runEvalTask, type EvalRunResult } from "../runner"
import {
  getDefaultEvalOutputRoot,
  loadEvalTasks,
  type DiscoveredEvalTask,
} from "./catalog"
import { resolveEvalTaskProvider } from "./provider-factory"
import type { EvalProviderMode } from "../schemas/task"

export type EvalSuiteTaskResult = {
  task: DiscoveredEvalTask
  result: EvalRunResult
  artifactDir: string
}

export type EvalSuiteResult = {
  outputRoot: string
  providerMode: EvalProviderMode
  results: EvalSuiteTaskResult[]
  pass: boolean
}

export async function runDiscoveredEvalTasks(input: {
  providerMode?: EvalProviderMode
  taskIds?: string[]
  tasksRoot?: string
  outputRoot?: string
  now?: () => number
} & Pick<
  DefaultProviderInput,
  "env" | "createClient" | "createOpenAIProviderImpl" | "createOpenAICompatibleProviderImpl"
> = {}): Promise<EvalSuiteResult> {
  const providerMode = input.providerMode ?? "scripted"
  const tasks = await loadEvalTasks({
    tasksRoot: input.tasksRoot,
    providerMode,
  })
  const selectedTasks = selectTasks(tasks, input.taskIds, providerMode)
  const outputRoot = input.outputRoot ?? join(getDefaultEvalOutputRoot(), createRunStamp())
  const results: EvalSuiteTaskResult[] = []

  await mkdir(outputRoot, { recursive: true })

  for (const task of selectedTasks) {
    assertSafeTaskId(task.id)
    const provider = resolveProviderOrThrow({
      task,
      providerMode,
      env: input.env,
      createClient: input.createClient,
      createOpenAIProviderImpl: input.createOpenAIProviderImpl,
      createOpenAICompatibleProviderImpl: input.createOpenAICompatibleProviderImpl,
    })
    const result = await runTaskOrThrow({
      task,
      providerMode,
      provider,
      env: input.env,
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
    providerMode,
    results,
    pass: results.every((entry) => entry.result.pass),
  }
}

export function formatEvalTaskSummary(input: EvalSuiteTaskResult) {
  const failures = summarizeFailures(input.result)

  return [
    `eval.task ${input.task.id}`,
    `provider.mode ${input.result.artifact.provider.mode}`,
    `provider.kind ${input.result.artifact.provider.kind}`,
    input.result.artifact.provider.model
      ? `provider.model ${input.result.artifact.provider.model}`
      : null,
    `run.status ${input.result.artifact.outcome.runStatus}`,
    `grader.outcome ${formatPass(input.result.grades.outcome.pass)}`,
    `grader.protocol ${formatPass(input.result.grades.protocol.pass)}`,
    `grader.tool_policy ${formatPass(input.result.grades.toolPolicy.pass)}`,
    `grader.trace ${formatPass(input.result.grades.trace.pass)}`,
    `grader.transcript ${formatPass(input.result.grades.transcript.pass)}`,
    `grader.trace_sequence ${formatPass(input.result.grades.traceSequence.pass)}`,
    `grader.tool_consumption ${formatPass(input.result.grades.toolConsumption.pass)}`,
    `grader.skill_disclosure ${formatPass(input.result.grades.skillDisclosure.pass)}`,
    `grader.prompt_assembly ${formatPass(input.result.grades.promptAssembly.pass)}`,
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

function selectTasks(
  tasks: DiscoveredEvalTask[],
  taskIds: string[] | undefined,
  providerMode: EvalProviderMode,
) {
  if (!taskIds || taskIds.length === 0) {
    return tasks
  }

  const selected = tasks.filter((task) => taskIds.includes(task.id))
  const missingTaskIds = taskIds.filter((taskId) => !selected.some((task) => task.id === taskId))

  if (missingTaskIds.length > 0) {
    throw new Error(
      `Unknown eval task ids for provider mode ${providerMode}: ${missingTaskIds.join(", ")}`,
    )
  }

  return selected
}

function resolveProviderOrThrow(input: {
  task: DiscoveredEvalTask
  providerMode: EvalProviderMode
} & Pick<
  DefaultProviderInput,
  "env" | "createClient" | "createOpenAIProviderImpl" | "createOpenAICompatibleProviderImpl"
>) {
  try {
    return resolveEvalTaskProvider(input)
  } catch (error) {
    if (input.providerMode === "live") {
      throw new Error(`Live eval provider setup failed: ${describeError(error)}`)
    }

    throw error
  }
}

async function runTaskOrThrow(input: {
  task: DiscoveredEvalTask
  providerMode: EvalProviderMode
  provider: ReturnType<typeof resolveEvalTaskProvider>
  env?: Record<string, string | undefined>
  now?: () => number
}) {
  try {
    return await runEvalTask({
      task: input.task,
      providerInfo: input.provider.providerInfo,
      createProvider: input.provider.createProvider,
      env: input.env,
      now: input.now,
    })
  } catch (error) {
    if (input.providerMode === "live") {
      throw new Error(
        `Live eval provider execution failed for ${input.task.id}: ${describeError(error)}`,
      )
    }

    throw error
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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

  if (!result.grades.transcript.pass) {
    if (result.grades.transcript.missingOrderedTexts.length > 0) {
      failures.push(`transcript missing ordered text ${result.grades.transcript.missingOrderedTexts.join(", ")}`)
    }

    if (result.grades.transcript.checkpointFailures.length > 0) {
      failures.push(...result.grades.transcript.checkpointFailures)
    }
  }

  if (!result.grades.traceSequence.pass && result.grades.traceSequence.missingOrderedEventTypes.length > 0) {
    failures.push(`trace sequence missing ${result.grades.traceSequence.missingOrderedEventTypes.join(", ")}`)
  }

  if (!result.grades.toolConsumption.pass && result.grades.toolConsumption.failures.length > 0) {
    failures.push(...result.grades.toolConsumption.failures)
  }

  if (!result.grades.skillDisclosure.pass && result.grades.skillDisclosure.failures.length > 0) {
    failures.push(...result.grades.skillDisclosure.failures)
  }

  if (!result.grades.promptAssembly.pass && result.grades.promptAssembly.failures.length > 0) {
    failures.push(...result.grades.promptAssembly.failures)
  }

  return failures.join("; ")
}

function resolveTaskArtifactDirectory(outputRoot: string, taskId: string) {
  return join(
    outputRoot,
    ...taskId
      .split("/")
      .map((segment) => {
        if (!segment || segment === "." || segment === "..") {
          throw new Error(`Eval task id contains an unsafe path segment: ${taskId}`)
        }

        return segment.replace(/[^a-zA-Z0-9._-]+/g, "_")
      }),
  )
}

function assertSafeTaskId(taskId: string) {
  resolveTaskArtifactDirectory("_", taskId)
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
