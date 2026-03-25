import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const activeProcesses: Array<Bun.Subprocess<"pipe", "pipe", "ignore">> = []
const tempDirectories: string[] = []

afterEach(async () => {
  while (activeProcesses.length > 0) {
    activeProcesses.pop()?.kill()
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("eval main entrypoint", () => {
  test("runs a selected eval task through the public bun run eval command", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "eval-main-success-"))
    tempDirectories.push(outputRoot)

    const process = spawnEvalMain([
      "--task",
      "regression/read-only",
      "--output-root",
      outputRoot,
    ])

    expect(await process.exited).toBe(0)

    const stdout = await readProcessStream(process.stdout)
    const stderr = await readProcessStream(process.stderr)

    expect(stdout).toContain("eval.task regression/read-only")
    expect(stdout).toContain("run.status completed")
    expect(stdout).toContain("grader.trace pass")
    expect(stdout).toContain(`artifact.dir ${join(outputRoot, "regression", "read-only")}`)
    expect(stdout).toContain("eval.suite pass 1")
    expect(stderr).not.toContain("Unknown eval task ids")
    expect(
      await Bun.file(join(outputRoot, "regression", "read-only", "metrics.json")).json(),
    ).toMatchObject({
      terminalEventType: "run.completed",
    })
  })

  test("surfaces unknown task ids through the public eval entrypoint", async () => {
    const process = spawnEvalMain(["--task", "regression/missing-task"])

    expect(await process.exited).toBe(1)

    const stdout = await readProcessStream(process.stdout)
    const stderr = await readProcessStream(process.stderr)

    expect(stdout.trim()).toBe("")
    expect(stderr).toContain("Unknown eval task ids: regression/missing-task")
  })
})

function spawnEvalMain(argv: string[]) {
  const subprocess = Bun.spawn({
    cmd: ["bun", "run", "eval", ...argv],
    cwd: globalThis.process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  activeProcesses.push(subprocess)
  return subprocess
}

async function readProcessStream(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) {
    return ""
  }

  return await new Response(stream).text()
}
