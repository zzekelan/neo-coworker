import { join } from "node:path"
import { createDefaultProvider } from "./main"
import { createAgentServer } from "./server"
import {
  createConversationRepository as createStorageRepository,
  openConversationDatabase as openStorageDatabase,
} from "./conversation/repo"

const DEFAULT_SERVER_HOST = "127.0.0.1"
const DEFAULT_SERVER_PORT = 3100

export type StandaloneServerConfig = {
  host: string
  port: number
  databasePath: string
}

export function getDefaultStandaloneServerStoragePath(cwd: string = process.cwd()) {
  return join(cwd, ".agents", "server.sqlite")
}

export function resolveStandaloneServerConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): StandaloneServerConfig {
  return {
    host: readEnvValue(env, "AGENT_SERVER_HOST") ?? DEFAULT_SERVER_HOST,
    port: parseServerPort(readEnvValue(env, "AGENT_SERVER_PORT")),
    databasePath: readEnvValue(env, "AGENT_SERVER_DB_PATH") ?? getDefaultStandaloneServerStoragePath(cwd),
  }
}

export async function startStandaloneServer(input: {
  env?: Record<string, string | undefined>
  cwd?: string
} = {}) {
  const env = input.env ?? process.env
  const config = resolveStandaloneServerConfig(env, input.cwd)
  const provider = await createDefaultProvider({
    env,
  })
  const database = openStorageDatabase(config.databasePath)

  try {
    const repository = createStorageRepository({
      database,
    })
    const server = createAgentServer({
      provider,
      repository,
    })
    await server.start({
      hostname: config.host,
      port: config.port,
    })

    return {
      server,
      config,
      async stop() {
        await server.stop()
        database.close(false)
      },
    }
  } catch (error) {
    database.close(false)
    throw error
  }
}

function readEnvValue(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function parseServerPort(value: string | undefined) {
  if (value == null) {
    return DEFAULT_SERVER_PORT
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("AGENT_SERVER_PORT must be a valid integer")
  }

  const port = Number.parseInt(value, 10)
  if (port < 1 || port > 65535) {
    throw new Error("AGENT_SERVER_PORT must be between 1 and 65535")
  }

  return port
}

async function waitForShutdown(input: { stop(): Promise<void> }) {
  await new Promise<void>((resolve) => {
    let stopping = false

    async function shutdown() {
      if (stopping) {
        return
      }

      stopping = true
      process.off("SIGINT", shutdown)
      process.off("SIGTERM", shutdown)

      try {
        await input.stop()
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      } finally {
        resolve()
      }
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })
}

if (import.meta.main) {
  try {
    const standaloneServer = await startStandaloneServer()
    console.log(`server.started ${standaloneServer.server.baseUrl}`)
    console.log(`server.storage ${standaloneServer.config.databasePath}`)
    await waitForShutdown(standaloneServer)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
