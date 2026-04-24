import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveAgentServerOrigin } from "../../src/bootstrap"
import {
  getDefaultStandaloneServerStoragePath,
  resolveStandaloneServerConfig,
  startStandaloneServer,
} from "../../src/app-server"
import {
  CURRENT_SESSION_SCHEMA_VERSION as CURRENT_STORAGE_SCHEMA_VERSION,
  openSessionDatabase as openStorageDatabase,
} from "../../src/session"
import { MODELS_DEV_CAPABILITY_SNAPSHOT } from "../../src/bootstrap/provider"

const tempDirectories: string[] = []
type ServerSubprocess = {
  exitCode: number | null
  kill(signal?: string): void
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
}

const bunRuntime = (globalThis as unknown as {
  Bun: {
    spawn(input: {
      cmd: string[]
      cwd: string
      env: Record<string, string>
      stdout: "pipe"
      stderr: "pipe"
      stdin: "ignore"
    }): ServerSubprocess
    spawnSync(input: {
      cmd: string[]
      cwd: string
      env: Record<string, string>
      stdout: "pipe"
      stderr: "pipe"
      stdin: "ignore"
    }): {
      exitCode: number | null
      stdout: Uint8Array
      stderr: Uint8Array
    }
    sleep(ms: number): Promise<void>
  }
}).Bun

const activeProcesses: ServerSubprocess[] = []

async function cleanupState() {
  while (activeProcesses.length > 0) {
    const process = activeProcesses.pop()!
    if (process.exitCode == null) {
      process.kill("SIGKILL")
    }
    await process.exited
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
}

describe("standalone server config", () => {
  test("derives the default storage path from the XDG data root", () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME
    const xdgDataHome = join(tmpdir(), "neo-coworker-server-test-xdg-data")
    process.env.XDG_DATA_HOME = xdgDataHome

    try {
      expect(getDefaultStandaloneServerStoragePath("/tmp/neo-workspace")).toBe(
        join(xdgDataHome, "neo-coworker", "server.sqlite"),
      )
    } finally {
      restoreOptionalEnv("XDG_DATA_HOME", originalXdgDataHome)
    }
  })

  test("reads host, port, and database path from AGENT_SERVER_* variables", () => {
    expect(
      resolveStandaloneServerConfig(
        {
          AGENT_SERVER_HOST: "0.0.0.0",
          AGENT_SERVER_PORT: "4317",
          AGENT_SERVER_DB_PATH: "/tmp/custom-server.sqlite",
        },
        "/tmp/ignored",
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 4317,
      databasePath: "/tmp/custom-server.sqlite",
    })
  })

  test("rejects invalid AGENT_SERVER_PORT values", () => {
    expect(() =>
      resolveStandaloneServerConfig(
        {
          AGENT_SERVER_PORT: "port",
        },
        "/tmp/neo-workspace",
      ),
    ).toThrow("NCOWORKER_SERVER_PORT must be a valid integer")
  })
})

describe("agent server origin", () => {
  test("accepts AGENT_SERVER_URL when it is an absolute HTTP URL", () => {
    expect(
      resolveAgentServerOrigin({
        AGENT_SERVER_URL: "http://127.0.0.1:3100",
      }),
    ).toBe("http://127.0.0.1:3100")
  })

  test("rejects AGENT_SERVER_URL when it includes a path prefix", () => {
    expect(() =>
      resolveAgentServerOrigin({
        AGENT_SERVER_URL: "http://127.0.0.1:3100/agent",
      }),
    ).toThrow("NCOWORKER_SERVER_URL must not include a path, query, or hash")
  })
})

describe("server main entrypoint", () => {
  test("serves merged workspace primary agents through /agents/primary", async () => {
    try {
      const directory = await mkdtemp(join(tmpdir(), "server-main-primary-agents-"))
      tempDirectories.push(directory)
      await writeModelsDevCache(directory)

      const workspaceRoot = join(directory, "workspace")
      await mkdir(join(workspaceRoot, ".ncoworker", "agents"), { recursive: true })
      await writeFile(
        join(workspaceRoot, ".ncoworker", "agents.yaml"),
        ["agents:", "  reviewer:", "    isPrimary: true", "    description: YAML primary agent"].join(
          "\n",
        ),
      )
      await writeFile(
        join(workspaceRoot, ".ncoworker", "agents", "reviewer.md"),
        [
          "---",
          "name: reviewer",
          "description: Markdown primary agent",
          "---",
          "# Reviewer",
        ].join("\n"),
      )

      const standaloneServer = await startStandaloneServer({
        cwd: directory,
        env: buildLoopbackEnv({
          NCOWORKER_SERVER_DB_PATH: join(directory, "server.sqlite"),
          NCOWORKER_SERVER_HOST: "127.0.0.1",
          NCOWORKER_SERVER_PORT: String(await allocateLoopbackPort()),
          LLM_PROVIDER: "openai-compatible",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "fake-model",
          LLM_BASE_URL: "https://example.invalid/v1",
        }),
      })

      try {
        const response = await fetchLoopback(
          `${standaloneServer.server.baseUrl}/agents/primary?workspaceRoot=${encodeURIComponent(workspaceRoot)}`,
        )

        expect(response.status).toBe(200)

        const body = (await response.json()) as {
          data: {
            agents: Array<{ name: string; description: string }>
          }
        }

        expect(body.data.agents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "default" }),
            expect.objectContaining({ name: "plan" }),
            { name: "reviewer", description: "Markdown primary agent" },
          ]),
        )
      } finally {
        await standaloneServer.stop()
      }
    } finally {
      await cleanupState()
    }
  })

  test("starts through the public entrypoint and serves /health on loopback", async () => {
    try {
      const directory = await mkdtemp(join(tmpdir(), "server-main-success-"))
      tempDirectories.push(directory)

      const databasePath = join(directory, "server.sqlite")
      await writeModelsDevCache(directory)
      const port = await allocateLoopbackPort()
      const process = spawnServerMain({
        NCOWORKER_SERVER_DB_PATH: databasePath,
        NCOWORKER_SERVER_HOST: "127.0.0.1",
        NCOWORKER_SERVER_PORT: String(port),
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "fake-model",
        LLM_BASE_URL: "https://example.invalid/v1",
      })

      await waitForHealth(`http://127.0.0.1:${port}/health`)

      process.kill("SIGINT")
      expect(await waitForExit(process)).toBe(0)

      const stdout = await readProcessStream(process.stdout)
      const stderr = await readProcessStream(process.stderr)

      expect(stdout.trim()).toBe("")
      expect(stderr).toContain(`server.started http://127.0.0.1:${port}`)
      expect(stderr).toContain(`server.storage ${databasePath}`)
    } finally {
      await cleanupState()
    }
  })

  test("surfaces database initialization failures through the public entrypoint", async () => {
    try {
      const directory = await mkdtemp(join(tmpdir(), "server-main-failure-"))
      tempDirectories.push(directory)

      const databasePath = join(directory, "future.sqlite")
      const database = openStorageDatabase(databasePath)
      database.exec("PRAGMA user_version = 999")
      database.close(false)

      const process = spawnServerMain({
        NCOWORKER_SERVER_DB_PATH: databasePath,
        NCOWORKER_SERVER_HOST: "127.0.0.1",
        NCOWORKER_SERVER_PORT: "3100",
        LLM_PROVIDER: "openai-compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "fake-model",
        LLM_BASE_URL: "https://example.invalid/v1",
      })

      expect(await waitForExit(process)).toBe(1)

      const stdout = await readProcessStream(process.stdout)
      const stderr = await readProcessStream(process.stderr)

      expect(stdout.trim()).toBe("")
      expect(stderr).toContain(
        `Failed to initialize storage at ${databasePath}: Database schema version 999 is newer than supported version ${CURRENT_STORAGE_SCHEMA_VERSION}`,
      )
    } finally {
      await cleanupState()
    }
  })
})

function spawnServerMain(overrides: Record<string, string>) {
  const subprocess = bunRuntime.spawn({
    cmd: ["bun", "run", "src/app-server/main.ts"],
    cwd: globalThis.process.cwd(),
    env: buildLoopbackEnv(overrides),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  activeProcesses.push(subprocess)
  return subprocess
}

function buildLoopbackEnv(overrides: Record<string, string>) {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) {
      env[key] = value
    }
  }

  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  env.NO_PROXY = "127.0.0.1,localhost"
  env.no_proxy = "127.0.0.1,localhost"

  return {
    ...env,
    ...overrides,
  }
}

async function writeModelsDevCache(directory: string) {
  await writeFile(
    join(directory, "models.dev.json"),
    JSON.stringify(MODELS_DEV_CAPABILITY_SNAPSHOT, null, 2),
  )
}

async function fetchLoopback(url: string) {
  const process = bunRuntime.spawn({
    cmd: [
      "bun",
      "-e",
      [
        "const url = process.argv.at(-1)",
        "const response = await fetch(url)",
        "const text = await response.text()",
        "process.stdout.write(JSON.stringify({ status: response.status, text }))",
      ].join("; "),
      url,
    ],
    cwd: globalThis.process.cwd(),
    env: buildLoopbackEnv({}),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    readProcessStream(process.stdout),
    readProcessStream(process.stderr),
  ])

  if (exitCode !== 0) {
    throw new Error(stderr)
  }

  const output = JSON.parse(stdout) as { status: number; text: string }
  return {
    status: output.status,
    async json() {
      return JSON.parse(output.text) as unknown
    },
    async text() {
      return output.text
    },
  }
}

function restoreOptionalEnv(name: string, value: string | undefined) {
  if (value == null) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

async function allocateLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port")))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(address.port)
      })
    })
  })
}

async function waitForHealth(url: string, timeoutMs = 5_000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
        const healthCheck = bunRuntime.spawnSync({
        cmd: [
          "bun",
          "-e",
          'const url = process.argv.at(-1); try { const response = await fetch(url); process.stdout.write(await response.text()); process.exit(response.ok ? 0 : 1); } catch (error) { process.stderr.write(String(error)); process.exit(1); }',
          url,
        ],
        cwd: globalThis.process.cwd(),
        env: buildLoopbackEnv({}),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })

      if (healthCheck.exitCode === 0 && healthCheck.stdout.toString().includes('"ok":true')) {
        return
      }
    } catch {
      // Keep polling until the subprocess starts listening.
    }

    await bunRuntime.sleep(50)
  }

  throw new Error(`Timed out waiting for healthy server at ${url}`)
}

async function waitForExit(process: ServerSubprocess, timeoutMs = 5_000) {
  return await Promise.race([
    process.exited,
    bunRuntime.sleep(timeoutMs).then(() => {
      throw new Error("Timed out waiting for server-main process to exit")
    }),
  ])
}

async function readProcessStream(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) {
    return ""
  }

  return await new Response(stream).text()
}
