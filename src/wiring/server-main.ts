import { createAgentServer } from "../orchestration/wiring/server"
import {
  createStandaloneServerComposition,
  getDefaultStandaloneServerStoragePath,
  resolveStandaloneServerConfig,
  type StandaloneServerConfig,
} from "../bootstrap/server"

export { getDefaultStandaloneServerStoragePath, resolveStandaloneServerConfig, type StandaloneServerConfig }

export async function startStandaloneServer(input: {
  env?: Record<string, string | undefined>
  cwd?: string
} = {}) {
  const composition = await createStandaloneServerComposition({
    env: input.env,
    cwd: input.cwd,
  })
  const server = createAgentServer({
    createRuntimeImpl: composition.createRuntimeImpl,
    repository: composition.repository,
    permissionRepository: composition.permissionRepository,
  })

  try {
    await server.start({
      hostname: composition.config.host,
      port: composition.config.port,
    })

    return {
      server,
      config: composition.config,
      async stop() {
        await server.stop()
        composition.closeDatabase()
      },
    }
  } catch (error) {
    composition.closeDatabase()
    throw error
  }
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
