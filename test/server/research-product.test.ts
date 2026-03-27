import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
} from "../../src/model"
import { createPermissionRepository } from "../../src/permission"
import { createAgentServer } from "../../src/app-server"
import {
  createKnowledgeFileStorage,
  createKnowledgeRepository,
  createKnowledgeRuntimeApi,
} from "../../src/knowledge"
import {
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  createRuntime,
} from "../../src/bootstrap"
import {
  createSessionRepository,
  openSessionDatabase,
} from "../../src/session"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []
const activeServers: Array<{ stop(): Promise<void> | void }> = []

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.stop()
  }

  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("research product server flow", () => {
  test("stages candidate materials, saves durable sources, and writes artifacts from saved assets", async () => {
    const harness = await createHarness(
      "research-product-flow",
      createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_fetch_source",
            name: "web_fetch",
            inputText: JSON.stringify({
              url: "https://example.test/agentic-coding",
            }),
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Candidate material staged for review.",
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_search_sources",
            name: "research_search_assets",
            inputText: JSON.stringify({
              query: "agentic coding",
              kind: "source",
            }),
          }
        },
        async function* (request) {
          const sourceAssetId = extractAssetIdFromMessages(request, "research_search_assets")
          yield {
            type: "tool.call",
            callId: "call_read_source",
            name: "research_read_asset",
            inputText: JSON.stringify({
              assetId: sourceAssetId,
            }),
          }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_artifact",
            name: "research_write_asset",
            inputText: JSON.stringify({
              kind: "artifact",
              title: "Agentic coding brief",
              content:
                "Agentic coding pairs an LLM with tools, approvals, and durable project sources.",
            }),
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Saved a grounded draft from the project sources.",
          }
        },
      ]),
      {
        permissionPolicy: {
          web_fetch: "ask",
        },
      },
    )

    const openedProject = await requestJson(harness.server, "POST", "/projects/open", {
      directory: harness.workspaceRoot,
      create: true,
    })
    expect(openedProject.status).toBe(200)
    expect(openedProject.body.data.project).toMatchObject({
      workspaceRoot: harness.workspaceRoot,
      threadCount: 0,
    })

    const createdThread = await requestJson(harness.server, "POST", "/project/threads", {
      workspaceRoot: harness.workspaceRoot,
      title: "Agentic coding study",
    })
    expect(createdThread.status).toBe(201)
    const sessionId = createdThread.body.data.thread.id as string

    const firstRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Find one solid article about agentic coding.",
    })
    const firstRunId = firstRun.body.data.run.id as string
    const waitingRun = await waitForRunStatus(harness.server, firstRunId, "waiting_permission")
    const permissionRequestId = waitingRun.permissionRequests[0]?.id as string
    expect(permissionRequestId).toBeTruthy()

    const approved = await requestJson(
      harness.server,
      "POST",
      `/permissions/${permissionRequestId}/reply`,
      {
        decision: "allow",
      },
    )
    expect(approved.status).toBe(200)
    await waitForRunStatus(harness.server, firstRunId, "completed")

    const knowledgeAfterFetch = await requestJson(
      harness.server,
      "GET",
      `/project/knowledge?workspaceRoot=${encodeURIComponent(harness.workspaceRoot)}`,
    )
    expect(knowledgeAfterFetch.status).toBe(200)
    expect(knowledgeAfterFetch.body.data.candidates).toHaveLength(1)
    expect(knowledgeAfterFetch.body.data.assets).toEqual([])

    const candidateId = knowledgeAfterFetch.body.data.candidates[0].id as string
    const savedSource = await requestJson(
      harness.server,
      "POST",
      `/project/candidates/${candidateId}/save`,
      {
        title: "Agentic coding overview",
      },
    )
    expect(savedSource.status).toBe(201)
    expect(savedSource.body.data.asset).toMatchObject({
      kind: "source",
      title: "Agentic coding overview",
    })
    const sourceAssetId = savedSource.body.data.asset.id as string

    const knowledgeAfterSave = await requestJson(
      harness.server,
      "GET",
      `/project/knowledge?workspaceRoot=${encodeURIComponent(harness.workspaceRoot)}`,
    )
    expect(knowledgeAfterSave.status).toBe(200)
    expect(knowledgeAfterSave.body.data.candidates[0]).toMatchObject({
      id: candidateId,
      status: "saved",
      savedAssetId: sourceAssetId,
    })
    expect(knowledgeAfterSave.body.data.assets).toEqual([
      expect.objectContaining({
        id: sourceAssetId,
        kind: "source",
      }),
    ])

    const secondRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Write a brief based on the saved source.",
    })
    const secondRunId = secondRun.body.data.run.id as string
    await waitForRunStatus(harness.server, secondRunId, "completed")

    const finalKnowledge = await requestJson(
      harness.server,
      "GET",
      `/project/knowledge?workspaceRoot=${encodeURIComponent(harness.workspaceRoot)}`,
    )
    expect(finalKnowledge.status).toBe(200)
    expect(finalKnowledge.body.data.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceAssetId,
          kind: "source",
        }),
        expect.objectContaining({
          kind: "artifact",
          title: "Agentic coding brief",
        }),
      ]),
    )

    const artifact = finalKnowledge.body.data.assets.find(
      (asset: { kind: string }) => asset.kind === "artifact",
    ) as { id: string }
    const artifactDocument = await requestJson(
      harness.server,
      "GET",
      `/project/assets/${artifact.id}`,
    )
    expect(artifactDocument.status).toBe(200)
    expect(artifactDocument.body.data.asset).toMatchObject({
      id: artifact.id,
      kind: "artifact",
    })
    expect(artifactDocument.body.data.content).toContain(
      "Agentic coding pairs an LLM with tools",
    )

    const projectSummary = await requestJson(
      harness.server,
      "GET",
      `/project?workspaceRoot=${encodeURIComponent(harness.workspaceRoot)}`,
    )
    expect(projectSummary.status).toBe(200)
    expect(projectSummary.body.data.project).toMatchObject({
      workspaceRoot: harness.workspaceRoot,
      threadCount: 1,
      assetCounts: {
        source: 1,
        note: 0,
        finding: 0,
        artifact: 1,
      },
      pendingCandidateCount: 0,
    })

    const listedProjects = await requestJson(harness.server, "GET", "/projects")
    expect(listedProjects.status).toBe(200)
    expect(listedProjects.body.data.projects).toEqual([
      expect.objectContaining({
        workspaceRoot: harness.workspaceRoot,
        threadCount: 1,
      }),
    ])
  })

  test("saved sources survive restart and remain readable through public project APIs", async () => {
    const harness = await createHarness(
      "research-product-restart",
      createTurnProvider([
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_fetch_source",
            name: "web_fetch",
            inputText: JSON.stringify({
              url: "https://example.test/research-restart",
            }),
          }
        },
        async function* () {
          yield {
            type: "text.delta",
            text: "Candidate ready.",
          }
        },
      ]),
      {
        permissionPolicy: {
          web_fetch: "ask",
        },
      },
    )

    const createdThread = await requestJson(harness.server, "POST", "/project/threads", {
      workspaceRoot: harness.workspaceRoot,
      title: "Restart coverage",
    })
    const sessionId = createdThread.body.data.thread.id as string

    const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Fetch a source that should survive restart.",
    })
    const runId = startedRun.body.data.run.id as string
    const waitingRun = await waitForRunStatus(harness.server, runId, "waiting_permission")
    const permissionRequestId = waitingRun.permissionRequests[0]?.id as string

    await requestJson(harness.server, "POST", `/permissions/${permissionRequestId}/reply`, {
      decision: "allow",
    })
    await waitForRunStatus(harness.server, runId, "completed")

    const knowledgeBeforeRestart = await requestJson(
      harness.server,
      "GET",
      `/project/knowledge?workspaceRoot=${encodeURIComponent(harness.workspaceRoot)}`,
    )
    const candidateId = knowledgeBeforeRestart.body.data.candidates[0].id as string

    const savedSource = await requestJson(
      harness.server,
      "POST",
      `/project/candidates/${candidateId}/save`,
      {},
    )
    const sourceAssetId = savedSource.body.data.asset.id as string

    await restartHarness(harness, createTurnProvider([]), {
      permissionPolicy: {
        web_fetch: "ask",
      },
    })

    const knowledgeAfterRestart = await requestJson(
      harness.server,
      "GET",
      `/project/knowledge?workspaceRoot=${encodeURIComponent(harness.workspaceRoot)}`,
    )
    expect(knowledgeAfterRestart.status).toBe(200)
    expect(knowledgeAfterRestart.body.data.candidates[0]).toMatchObject({
      id: candidateId,
      status: "saved",
      savedAssetId: sourceAssetId,
    })
    expect(knowledgeAfterRestart.body.data.assets).toEqual([
      expect.objectContaining({
        id: sourceAssetId,
        kind: "source",
      }),
    ])

    const sourceDocument = await requestJson(
      harness.server,
      "GET",
      `/project/assets/${sourceAssetId}`,
    )
    expect(sourceDocument.status).toBe(200)
    expect(sourceDocument.body.data.asset).toMatchObject({
      id: sourceAssetId,
      kind: "source",
    })
    expect(sourceDocument.body.data.content).toContain("Local-first research agents")
  })
})

async function createHarness(
  prefix: string,
  provider: ReturnType<typeof createTurnProvider>,
  options: {
    permissionPolicy?: Partial<Record<string, "allow" | "ask" | "deny">>
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  await mkdir(workspaceRoot, { recursive: true })

  const databasePath = join(directory, "agent.sqlite")
  const database = openSessionDatabase(databasePath)
  openDatabases.push(database)

  const now = createMonotonicClock()
  const repository = createSessionRepository({
    database,
    now,
  })
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const observabilityRepository = createObservabilityRepository({
    database,
    now,
  })
  const observability = createObservabilityRuntimeApi({
    repository: observabilityRepository,
    now,
  })
  const knowledgeRepository = createKnowledgeRepository({
    database,
    now,
  })
  const knowledge = createKnowledgeRuntimeApi({
    repository: knowledgeRepository,
    storage: createKnowledgeFileStorage(),
    now,
  })
  const server = createAgentServer({
    createRuntimeImpl(runtimeInput) {
      return createRuntime({
        provider,
        repository: runtimeInput.repository,
        permissionRepository: runtimeInput.permissionRepository,
        observability,
        permissionPolicy: options.permissionPolicy,
        researchTools: runtimeInput.researchTools,
        now: runtimeInput.now,
      })
    },
    repository,
    permissionRepository,
    knowledge,
    exportRunTraceImpl: observability.exportRunTrace,
    now,
    heartbeatIntervalMs: 15,
    fetchExternalContent({ url }) {
      return {
        title: `Fetched ${new URL(url).pathname.slice(1)}`,
        sourceUrl: url,
        content:
          "Local-first research agents keep sources, notes, and drafts inside the project directory.",
        contentType: "text/plain",
      }
    },
  })
  activeServers.push(server)

  return {
    databasePath,
    workspaceRoot,
    server,
    now,
  }
}

async function restartHarness(
  harness: {
    databasePath: string
    workspaceRoot: string
    now: () => number
    server: { stop(): Promise<void> | void }
  },
  provider: ReturnType<typeof createTurnProvider>,
  options: {
    permissionPolicy?: Partial<Record<string, "allow" | "ask" | "deny">>
  } = {},
) {
  await harness.server.stop()
  activeServers.pop()
  openDatabases.pop()?.close(false)

  const reopenedDatabase = openSessionDatabase(harness.databasePath)
  openDatabases.push(reopenedDatabase)

  const reopenedRepository = createSessionRepository({
    database: reopenedDatabase,
    now: harness.now,
  })
  const reopenedPermissionRepository = createPermissionRepository({
    database: reopenedDatabase,
    now: harness.now,
  })
  const reopenedObservabilityRepository = createObservabilityRepository({
    database: reopenedDatabase,
    now: harness.now,
  })
  const reopenedObservability = createObservabilityRuntimeApi({
    repository: reopenedObservabilityRepository,
    now: harness.now,
  })
  const reopenedKnowledgeRepository = createKnowledgeRepository({
    database: reopenedDatabase,
    now: harness.now,
  })
  const reopenedKnowledge = createKnowledgeRuntimeApi({
    repository: reopenedKnowledgeRepository,
    storage: createKnowledgeFileStorage(),
    now: harness.now,
  })
  const reopenedServer = createAgentServer({
    createRuntimeImpl(runtimeInput) {
      return createRuntime({
        provider,
        repository: runtimeInput.repository,
        permissionRepository: runtimeInput.permissionRepository,
        observability: reopenedObservability,
        permissionPolicy: options.permissionPolicy,
        researchTools: runtimeInput.researchTools,
        now: runtimeInput.now,
      })
    },
    repository: reopenedRepository,
    permissionRepository: reopenedPermissionRepository,
    knowledge: reopenedKnowledge,
    exportRunTraceImpl: reopenedObservability.exportRunTrace,
    now: harness.now,
    heartbeatIntervalMs: 15,
    fetchExternalContent({ url }) {
      return {
        title: `Fetched ${new URL(url).pathname.slice(1)}`,
        sourceUrl: url,
        content:
          "Local-first research agents keep sources, notes, and drafts inside the project directory.",
        contentType: "text/plain",
      }
    },
  })
  activeServers.push(reopenedServer)
  harness.server = reopenedServer
}

async function requestJson(
  server: { fetch(request: Request): Promise<Response> | Response },
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await server.fetch(
    new Request(`http://server.test${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )

  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  }
}

async function waitForRunStatus(
  server: { fetch(request: Request): Promise<Response> | Response },
  runId: string,
  status: string,
  timeoutMs = 2_000,
) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const run = await requestJson(server, "GET", `/runs/${runId}`)
    if (run.status === 200 && run.body.data.run.status === status) {
      return run.body.data as {
        run: Record<string, any>
        permissionRequests: Array<Record<string, any>>
      }
    }

    await Bun.sleep(20)
  }

  throw new Error(`Timed out waiting for run ${runId} to reach ${status}`)
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
) {
  let index = 0

  return createModelProvider({
    runtime: createModelRuntimeApi({
      async *streamTurn(request: ProviderTurnRequest) {
        const turn = turns[index]
        index += 1

        if (!turn) {
          throw new Error(`Unexpected provider turn ${index}`)
        }

        for await (const event of turn(request)) {
          yield event
        }
      },
    }),
  })
}

function createMonotonicClock(start = 10_000) {
  let current = start

  return () => {
    current += 1
    return current
  }
}

function extractAssetIdFromMessages(request: ProviderTurnRequest, toolName: string) {
  const toolMessages = request.messages.filter((message) => message.role === "tool")
  const match = [...toolMessages]
    .reverse()
    .flatMap((message) => message.parts)
    .find(
      (part) =>
        part.type === "tool_result" &&
        part.toolName === toolName &&
        /^asset_[^|\s]+/.test(part.output),
    )

  if (!match || match.type !== "tool_result") {
    throw new Error(`Missing tool result for ${toolName}`)
  }

  const assetId = match.output.split("|")[0]?.trim()
  if (!assetId) {
    throw new Error(`Could not parse asset id from ${toolName}`)
  }

  return assetId
}
