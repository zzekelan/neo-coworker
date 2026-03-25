import {
  createAgentServerClient,
  createLocalCliServerClient,
  createStdioCliIo,
  parseRunCommand,
  runCli,
} from "./cli"
import {
  createDefaultProvider,
  createObservabilityRuntimeApi,
  createCliStorageComposition,
  createRuntime,
  resolveAgentServerOrigin,
  resolveDefaultProviderConfig,
  type DefaultProviderInput,
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

export function buildCli(input: BuildCliInput = {}) {
  return {
    parse(argv: string[]) {
      return parseRunCommand(argv)
    },
    async run(argv: string[]) {
      parseRunCommand(argv)
      const runCliImpl = input.runCliImpl ?? runCli
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
        const provider =
          input.provider ??
          (await createDefaultProvider({
            env: input.env,
            createClient: input.createClient,
            createOpenAIProviderImpl: input.createOpenAIProviderImpl,
            createOpenAICompatibleProviderImpl: input.createOpenAICompatibleProviderImpl,
          }))

        await runCliImpl({
          argv,
          io: input.createIo?.() ?? createStdioCliIo(),
          provider,
          createLocalCliServerClientImpl: createLocalCliServerClient,
          createLocalRuntimeImpl(runtimeInput) {
            return createRuntime({
              ...runtimeInput,
              observability,
            })
          },
          createLocalStorageImpl(workspaceRoot) {
            const storage = getLocalStorage(workspaceRoot)

            return {
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

if (import.meta.main) {
  const cli = buildCli()

  try {
    await cli.run(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
