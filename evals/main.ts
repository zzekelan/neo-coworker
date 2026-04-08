import { runDiscoveredEvalTasks, formatEvalTaskSummary, loadEvalTasks } from "./index"
import type { EvalProviderMode } from "./schemas/task"

type EvalCommand = {
  listOnly: boolean
  providerMode: EvalProviderMode
  providerModeExplicit: boolean
  outputRoot?: string
  taskIds: string[]
}

export function parseEvalCommand(argv: string[]): EvalCommand {
  const taskIds: string[] = []
  let listOnly = false
  let providerMode: EvalProviderMode = "scripted"
  let providerModeExplicit = false
  let outputRoot: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (!argument) {
      continue
    }

    if (argument === "--list") {
      listOnly = true
      continue
    }

    if (argument === "--mode") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--mode requires a value")
      }

      providerMode = parseProviderMode(value)
      providerModeExplicit = true
      index += 1
      continue
    }

    if (argument.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length)
      if (!value) {
        throw new Error("--mode requires a value")
      }

      providerMode = parseProviderMode(value)
      providerModeExplicit = true
      continue
    }

    if (argument === "--task") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--task requires a value")
      }

      taskIds.push(value)
      index += 1
      continue
    }

    if (argument.startsWith("--task=")) {
      const value = argument.slice("--task=".length)
      if (!value) {
        throw new Error("--task requires a value")
      }

      taskIds.push(value)
      continue
    }

    if (argument === "--output-root") {
      const value = argv[index + 1]
      if (!value) {
        throw new Error("--output-root requires a value")
      }

      outputRoot = value
      index += 1
      continue
    }

    if (argument.startsWith("--output-root=")) {
      const value = argument.slice("--output-root=".length)
      if (!value) {
        throw new Error("--output-root requires a value")
      }

      outputRoot = value
      continue
    }

    throw new Error(`Unknown eval argument: ${argument}`)
  }

  return {
    listOnly,
    providerMode,
    providerModeExplicit,
    outputRoot,
    taskIds,
  }
}

function parseProviderMode(value: string): EvalProviderMode {
  if (value === "scripted" || value === "live") {
    return value
  }

  throw new Error("--mode must be one of: scripted, live")
}

export async function runEvalCommand(argv: string[]) {
  const command = parseEvalCommand(argv)

  if (command.listOnly) {
    const providerModes = command.providerModeExplicit
      ? [command.providerMode]
      : (["scripted", "live"] as const)
    const taskSets = await Promise.all(
      providerModes.map((providerMode) =>
        loadEvalTasks({
          providerMode,
        }),
      ),
    )
    const tasks = [...new Map(taskSets.flat().map((task) => [task.id, task])).values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )

    for (const task of tasks) {
      console.log(`eval.task ${task.id}`)
    }

    return {
      pass: true,
    }
  }

  const suite = await runDiscoveredEvalTasks({
    providerMode: command.providerMode,
    taskIds: command.taskIds,
    outputRoot: command.outputRoot,
  })

  for (const result of suite.results) {
    console.log(formatEvalTaskSummary(result))
  }

  console.log(
    `eval.suite ${suite.pass ? "pass" : "fail"} ${suite.results.length} provider.mode ${suite.providerMode}`,
  )

  return suite
}

if (import.meta.main) {
  try {
    const result = await runEvalCommand(Bun.argv.slice(2))

    if (!result.pass) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
