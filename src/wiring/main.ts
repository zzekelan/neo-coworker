import {
  createAgentServerClient,
  createLocalCliServerClient,
  createStdioCliIo,
  parseRunCommand,
  runCli,
} from "../orchestration/wiring/cli"
import type { ModelProvider } from "../model"
import {
  createDefaultProvider,
  resolveAgentServerOrigin,
  resolveDefaultProviderConfig,
  type DefaultProviderInput,
} from "../bootstrap/provider"
import { createCliStorageComposition, createRuntime } from "../bootstrap/runtime"

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
          return createRuntime(runtimeInput)
        },
        createLocalStorageImpl(workspaceRoot) {
          const storage = createCliStorageComposition({
            workspaceRoot,
          })

          return {
            repository: storage.repository,
            permissionRepository: storage.permissionRepository,
            closeImpl() {
              storage.close()
            },
          }
        },
      })
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
