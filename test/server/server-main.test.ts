import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveAgentServerOrigin } from "../../src/main"
import {
  getDefaultStandaloneServerStoragePath,
  resolveStandaloneServerConfig,
} from "../../src/server-main"
import { CURRENT_STORAGE_SCHEMA_VERSION, openStorageDatabase } from "../../src/storage"

const tempDirectories: string[] = []
const activeProcesses: Bun.Subprocess[] = []

afterEach(async () => {
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
})

describe("standalone server config", () => {
  test("derives the default storage path from the launch cwd", () => {
    expect(getDefaultStandaloneServerStoragePath("/tmp/neo-workspace")).toBe(
      join("/tmp/neo-workspace", ".agents", "server.sqlite"),
    )
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
    ).toThrow("AGENT_SERVER_PORT must be a valid integer")
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
    ).toThrow("AGENT_SERVER_URL must not include a path, query, or hash")
  })
})

describe("server main entrypoint", () => {
  test("starts through the public entrypoint and serves /health on loopback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "server-main-success-"))
    tempDirectories.push(directory)

    const databasePath = join(directory, "server.sqlite")
    const port = await allocateLoopbackPort()
    const process = spawnServerMain({
      AGENT_SERVER_DB_PATH: databasePath,
      AGENT_SERVER_HOST: "127.0.0.1",
      AGENT_SERVER_PORT: String(port),
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

    expect(stdout).toContain(`server.started http://127.0.0.1:${port}`)
    expect(stdout).toContain(`server.storage ${databasePath}`)
    expect(stderr.trim()).toBe("")
  })

  test("surfaces database initialization failures through the public entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "server-main-failure-"))
    tempDirectories.push(directory)

    const databasePath = join(directory, "future.sqlite")
    const database = openStorageDatabase(databasePath)
    database.exec("PRAGMA user_version = 999")
    database.close(false)

    const process = spawnServerMain({
      AGENT_SERVER_DB_PATH: databasePath,
      AGENT_SERVER_HOST: "127.0.0.1",
      AGENT_SERVER_PORT: "3100",
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
  })
})

function spawnServerMain(overrides: Record<string, string>) {
  const subprocess = Bun.spawn({
    cmd: ["bun", "run", "src/server-main.ts"],
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
      const healthCheck = Bun.spawnSync({
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

    await Bun.sleep(50)
  }

  throw new Error(`Timed out waiting for healthy server at ${url}`)
}

async function waitForExit(process: Bun.Subprocess, timeoutMs = 5_000) {
  return await Promise.race([
    process.exited,
    Bun.sleep(timeoutMs).then(() => {
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
