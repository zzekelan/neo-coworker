import { runDiscoveredEvalTasks, formatEvalTaskSummary, loadEvalTasks } from "./index"
import { EvalProviderModeSchema, type EvalProviderMode } from "./schemas/task"

type EvalCommand = {
  listOnly: boolean
  providerMode: EvalProviderMode
  outputRoot?: string
  taskIds: string[]
}

export function parseEvalCommand(argv: string[]): EvalCommand {
  const taskIds: string[] = []
  let listOnly = false
  let providerMode: EvalProviderMode = "scripted"
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

      providerMode = EvalProviderModeSchema.parse(value)
      index += 1
      continue
    }

    if (argument.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length)
      if (!value) {
        throw new Error("--mode requires a value")
      }

      providerMode = EvalProviderModeSchema.parse(value)
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
    outputRoot,
    taskIds,
  }
}

export async function runEvalCommand(argv: string[]) {
  const command = parseEvalCommand(argv)

  if (command.listOnly) {
    const tasks = await loadEvalTasks({
      providerMode: command.providerMode,
    })

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
