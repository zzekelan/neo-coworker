import {
  createAgentServerClient,
  createLocalCliServerClient,
  createStdioCliIo,
  parseCliCommand,
  runCli,
} from "./cli"
import {
  createDefaultProvider,
  createDefaultSearchBackend,
  createObservabilityRuntimeApi,
  createCliStorageComposition,
  createRuntime,
  resolveContextWindowSize,
  resolveAgentServerOrigin,
  resolveDefaultProviderConfig,
  type DefaultProviderInput,
  type ModelObserverPort,
  type ModelProvider,
} from "../bootstrap"

type BuildCliInput = {
  provider?: ModelProvider
  createAgentServerClientImpl?: typeof createAgentServerClient
  createIo?: typeof createStdioCliIo
  runCliImpl?: typeof runCli
} & Pick<
  DefaultProviderInput,
  "env" | "createClient" | "createOpenAIProviderImpl" | "createOpenAICompatibleProviderImpl"
>

export { createDefaultProvider, resolveAgentServerOrigin, resolveDefaultProviderConfig }

function isMainModule() {
  if (!process.argv[1]) {
    return false
  }

  return import.meta.url === new URL(process.argv[1], "file:").href
}

export function buildCli(input: BuildCliInput = {}) {
  return {
    parse(argv: string[]) {
      return parseCliCommand(argv)
    },
    async run(argv: string[]) {
      const command = parseCliCommand(argv)
      const runCliImpl = input.runCliImpl ?? runCli

      if (command.command === "insights") {
        await runCliImpl({
          argv,
          io: input.createIo?.() ?? createStdioCliIo(),
          createLocalStorageImpl(workspaceRoot) {
            const storage = createCliStorageComposition({
              workspaceRoot,
            })

            return {
              database: storage.database,
              repository: storage.repository,
              permissionRepository: storage.permissionRepository,
              closeImpl() {
                storage.close()
              },
            }
          },
        })
        return
      }

      const serverOrigin = resolveAgentServerOrigin(input.env)

      if (serverOrigin) {
        await runCliImpl({
          argv,
          io: input.createIo?.() ?? createStdioCliIo(),
          client: (input.createAgentServerClientImpl ?? createAgentServerClient)({
            origin: serverOrigin,
          }),
        })
        return
      }

      let observability:
        | ReturnType<typeof createObservabilityRuntimeApi>
        | undefined
      const deferredModelObserver: ModelObserverPort = {
        recordModelEvent(event) {
          try {
            observability?.modelObserver.recordModelEvent(event)
          } catch {
            // Observability must not alter the CLI provider path.
          }
        },
      }

      function getLocalStorage(workspaceRoot: string) {
        const storage = createCliStorageComposition({
          workspaceRoot,
        })
        observability =
          observability ??
          (storage.observabilityRepository
            ? createObservabilityRuntimeApi({
                repository: storage.observabilityRepository,
              })
            : undefined)
        return storage
      }

      try {
        const shouldResolveContextWindow =
          input.provider == null &&
          input.createClient == null &&
          input.createOpenAIProviderImpl == null &&
          input.createOpenAICompatibleProviderImpl == null
        const contextWindow =
          shouldResolveContextWindow
            ? (await resolveContextWindowSize({
                env: input.env,
              })).contextWindow
            : undefined
        const provider =
          input.provider ??
          (await createDefaultProvider({
            env: input.env,
            modelObserver: deferredModelObserver,
            createClient: input.createClient,
            createOpenAIProviderImpl: input.createOpenAIProviderImpl,
            createOpenAICompatibleProviderImpl: input.createOpenAICompatibleProviderImpl,
          }))
        const searchBackend = createDefaultSearchBackend({
          env: input.env,
        })

        await runCliImpl({
          argv,
          io: input.createIo?.() ?? createStdioCliIo(),
          provider,
          createLocalCliServerClientImpl: createLocalCliServerClient,
          createLocalRuntimeImpl(runtimeInput) {
            return createRuntime({
              ...runtimeInput,
              observability,
              searchBackend,
              contextWindow,
            })
          },
          createLocalStorageImpl(workspaceRoot) {
            const storage = getLocalStorage(workspaceRoot)

            return {
              database: storage.database,
              repository: storage.repository,
              permissionRepository: storage.permissionRepository,
              closeImpl() {
                storage.close()
              },
            }
          },
        })
      } catch (error) {
        throw error
      }
    },
  }
}

if (isMainModule()) {
  const cli = buildCli()

  try {
    await cli.run(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
