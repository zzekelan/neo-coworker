import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
} from "../../src/model"
import type { OrchestrationModelPort } from "../../src/orchestration"
import { createPermissionRepository } from "../../src/permission"
import { createAgentServer } from "../../src/app-server"
import {
  createSessionDeletionCoordinator,
  createObservabilityRepository,
  createObservabilityRuntimeApi,
  createRuntime,
} from "../../src/bootstrap"
import { createWorkspaceSkillRuntime } from "../../src/skill"
import {
  type SessionRepository,
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
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

describe("server HTTP API and SSE", () => {
  test("creates session, starts run, and exposes session and transcript state over HTTP", async () => {
    const harness = await createHarness("server-http-happy", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Server says hi." }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    expect(createdSession.status).toBe(201)

    const sessionId = createdSession.body.data.session.id as string

    const listedSessions = await requestJson(harness.server, "GET", "/sessions")
    expect(listedSessions.status).toBe(200)
    expect(listedSessions.body.data.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        directory: harness.workspaceRoot,
        workspaceRoot: harness.workspaceRoot,
        title: "New session",
        latestUserMessagePreview: null,
        latestRunStatus: null,
        updatedAt: expect.any(Number),
      }),
    ])

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Say hi from the server",
      },
    )
    expect(startedRun.status).toBe(201)
    expect(startedRun.body.data.run).toMatchObject({
      sessionId,
      trigger: "prompt",
      status: "queued",
      activeSkills: [],
    })

    const runId = startedRun.body.data.run.id as string

    const completedRun = await waitForRunStatus(harness.server, runId, "completed")
    expect(completedRun.permissionRequests).toEqual([])

    const sessionState = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionState.status).toBe(200)
    expect(sessionState.body.data).toMatchObject({
      session: {
        id: sessionId,
        title: "Say hi from the server",
        latestUserMessagePreview: "Say hi from the server",
        latestRunStatus: "completed",
        updatedAt: expect.any(Number),
      },
      latestRun: {
        id: runId,
        status: "completed",
      },
      activeRun: null,
      status: "idle",
    })

    const listedSessionsAfterRun = await requestJson(harness.server, "GET", "/sessions")
    expect(listedSessionsAfterRun.status).toBe(200)
    expect(listedSessionsAfterRun.body.data.sessions).toEqual([
      expect.objectContaining({
        id: sessionId,
        title: "Say hi from the server",
        latestUserMessagePreview: "Say hi from the server",
        latestRunStatus: "completed",
        updatedAt: expect.any(Number),
      }),
    ])

    const listedRuns = await requestJson(harness.server, "GET", `/sessions/${sessionId}/runs`)
    expect(listedRuns.status).toBe(200)
    expect(listedRuns.body.data.runs).toEqual([
      expect.objectContaining({
        id: runId,
        status: "completed",
      }),
    ])

    const transcript = await requestJson(harness.server, "GET", `/sessions/${sessionId}/transcript`)
    expect(transcript.status).toBe(200)
    expect(transcript.body.data.transcript).toMatchObject([
      {
        runId,
        role: "user",
        parts: [{ kind: "text", text: "Say hi from the server" }],
      },
      {
        runId,
        role: "assistant",
        parts: [{ kind: "text", text: "Server says hi." }],
      },
    ])
  })

  test("exports a completed run trace over HTTP", async () => {
    const harness = await createHarness("server-http-trace", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_read",
          name: "read",
          inputText: '{"path":"placeholder.txt"}',
        }
      },
      async function* () {
        yield { type: "text.delta", text: "Trace export ready." }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Read placeholder.txt",
      },
    )
    const runId = startedRun.body.data.run.id as string

    await waitForRunStatus(harness.server, runId, "completed")

    const exportedTrace = await requestJson(harness.server, "GET", `/runs/${runId}/trace`)
    expect(exportedTrace.status).toBe(200)
    expect(exportedTrace.body.data.trace).toMatchObject({
      sessionId,
      runId,
    })
    expect(
      exportedTrace.body.data.trace.events.map((event: { eventType: string }) => event.eventType),
    ).toEqual(
      expect.arrayContaining(["run.started", "tool.call.completed", "run.completed"]),
    )
  })

  test("failed prompt persistence does not leave the session busy", async () => {
    let failNextPromptWrite = true
    const harness = await createHarness(
      "server-http-start-run-rollback",
      createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Recovered after rollback." }
        },
      ]),
      {
        repositoryFactory(repository) {
          return {
            ...repository,
            createQueuedRunWithInitiatingMessageAndPart(input) {
              if (failNextPromptWrite) {
                failNextPromptWrite = false
                throw new Error("disk full")
              }

              return repository.createQueuedRunWithInitiatingMessageAndPart(input)
            },
          }
        },
      },
    )

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const failedStart = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "This one should roll back",
      },
    )

    expect(failedStart.status).toBe(500)
    expect(failedStart.body).toMatchObject({
      error: {
        code: "internal_error",
        message: "disk full",
      },
    })

    expect(harness.repository.runs.listBySession(sessionId)).toEqual([])

    const sessionStateAfterFailure = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionStateAfterFailure.status).toBe(200)
    expect(sessionStateAfterFailure.body.data).toMatchObject({
      latestRun: null,
      activeRun: null,
      status: "idle",
    })

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "This one should succeed",
      },
    )
    expect(startedRun.status).toBe(201)

    const runId = startedRun.body.data.run.id as string
    const completedRun = await waitForRunStatus(harness.server, runId, "completed")

    expect(completedRun.run).toMatchObject({
      id: runId,
      status: "completed",
    })
  })

  test("SSE sends heartbeat and duplicate subscribers receive the same live run and part updates", async () => {
    const harness = await createHarness("server-sse-dup", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Streaming " }
        await Bun.sleep(30)
        yield { type: "text.delta", text: "from SSE." }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const subscriberA = await connectSse(harness.server)
    const subscriberB = await connectSse(harness.server)

    expect(await subscriberA.next((event) => event.event === "heartbeat")).toMatchObject({
      event: "heartbeat",
      data: {
        type: "heartbeat",
      },
    })
    expect(await subscriberB.next((event) => event.event === "heartbeat")).toMatchObject({
      event: "heartbeat",
      data: {
        type: "heartbeat",
      },
    })

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Show me SSE",
      },
    )
    const runId = startedRun.body.data.run.id as string

    const eventsA = await collectEventsUntil(subscriberA, (event) =>
      event.event === "run.updated" && event.data.run.status === "completed",
    )
    const eventsB = await collectEventsUntil(subscriberB, (event) =>
      event.event === "run.updated" && event.data.run.status === "completed",
    )

    const filteredA = simplifyRelevantEvents(eventsA, runId)
    const filteredB = simplifyRelevantEvents(eventsB, runId)

    expect(filteredA).toEqual(filteredB)
    expect(filteredA).toEqual(
      expect.arrayContaining([
        { event: "run.updated", id: runId, status: "running" },
        { event: "message.part.updated", id: expect.any(String), kind: "text" },
        { event: "run.updated", id: runId, status: "completed" },
      ]),
    )

    await subscriberA.close()
    await subscriberB.close()
  })

  test("disables Bun idle timeout for SSE subscriptions", async () => {
    const harness = await createHarness("server-sse-timeout", createTurnProvider([]))
    const request = new Request("http://server.test/events", {
      headers: {
        accept: "text/event-stream",
      },
    })
    const timeoutCalls: Array<{ request: Request; seconds: number }> = []

    const response = await harness.server.fetch(request, {
      timeout(receivedRequest, seconds) {
        timeoutCalls.push({
          request: receivedRequest,
          seconds,
        })
      },
    } as unknown as Parameters<typeof harness.server.fetch>[1])

    expect(response.status).toBe(200)
    expect(timeoutCalls).toEqual([
      {
        request,
        seconds: 0,
      },
    ])

    await response.body?.cancel()
  })

  test("permission replies over HTTP resume the paused run and complete the work", async () => {
    const harness = await createHarness("server-permission", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_write",
          name: "write",
          inputText: '{"path":"notes.txt","content":"hello from server"}',
        }
      },
      async function* () {
        yield { type: "text.delta", text: "Write finished." }
      },
    ]), {
      permissionPolicy: {
        write: "ask",
      },
    })

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Write notes.txt",
      },
    )
    const runId = startedRun.body.data.run.id as string

    const waitingRun = await waitForRunStatus(harness.server, runId, "waiting_permission")
    expect(waitingRun.permissionRequests).toHaveLength(1)
    expect(waitingRun.permissionRequests[0]).toMatchObject({
      runId,
      sessionId,
      toolName: "write",
      status: "pending",
    })

    const permissionReply = await requestJson(
      harness.server,
      "POST",
      `/permissions/${waitingRun.permissionRequests[0].id}/reply`,
      {
        decision: "allow",
      },
    )
    expect(permissionReply.status).toBe(200)
    expect(permissionReply.body.data).toMatchObject({
      run: {
        id: runId,
        status: "running",
      },
      permissionRequest: {
        id: waitingRun.permissionRequests[0].id,
        status: "approved",
      },
    })

    const duplicatePermissionReply = await requestJson(
      harness.server,
      "POST",
      `/permissions/${waitingRun.permissionRequests[0].id}/reply`,
      {
        decision: "allow",
      },
    )
    expect(duplicatePermissionReply.status).toBe(409)
    expect(duplicatePermissionReply.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("not pending"),
      },
    })

    const completedRun = await waitForRunStatus(harness.server, runId, "completed")
    expect(completedRun.permissionRequests).toMatchObject([
      {
        id: waitingRun.permissionRequests[0].id,
        status: "approved",
      },
    ])
    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe(
      "hello from server",
    )
  })

  test("permission reply recovers a detached pending request after server restart", async () => {
    const harness = await createHarness("server-permission-restart-allow", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_write",
          name: "write",
          inputText: '{"path":"notes.txt","content":"hello after restart"}',
        }
      },
    ]), {
      permissionPolicy: {
        write: "ask",
      },
    })

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Write notes.txt after restart",
      },
    )
    const runId = startedRun.body.data.run.id as string

    const waitingRun = await waitForRunStatus(harness.server, runId, "waiting_permission")
    const permissionId = waitingRun.permissionRequests[0].id as string

    await restartHarness(
      harness,
      createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Write finished after restart." }
        },
      ]),
      {
        permissionPolicy: {
          write: "ask",
        },
      },
    )

    const response = await requestJson(
      harness.server,
      "POST",
      `/permissions/${permissionId}/reply`,
      {
        decision: "allow",
      },
    )

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      run: {
        id: runId,
        status: "running",
      },
      permissionRequest: {
        id: permissionId,
        status: "approved",
      },
    })

    const completedRun = await waitForRunStatus(harness.server, runId, "completed")
    expect(completedRun.permissionRequests).toMatchObject([
      {
        id: permissionId,
        status: "approved",
      },
    ])
    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe(
      "hello after restart",
    )
  })

  test("permission denial recovers a detached pending request after server restart", async () => {
    const harness = await createHarness("server-permission-restart-deny", createTurnProvider([
      async function* () {
        yield {
          type: "tool.call",
          callId: "call_write",
          name: "write",
          inputText: '{"path":"notes.txt","content":"should not exist"}',
        }
      },
    ]), {
      permissionPolicy: {
        write: "ask",
      },
    })

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Try to write notes.txt after restart",
      },
    )
    const runId = startedRun.body.data.run.id as string

    const waitingRun = await waitForRunStatus(harness.server, runId, "waiting_permission")
    const permissionId = waitingRun.permissionRequests[0].id as string

    await restartHarness(harness, createTurnProvider([]), {
      permissionPolicy: {
        write: "ask",
      },
    })

    const response = await requestJson(
      harness.server,
      "POST",
      `/permissions/${permissionId}/reply`,
      {
        decision: "deny",
      },
    )

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      run: {
        id: runId,
        status: "running",
      },
      permissionRequest: {
        id: permissionId,
        status: "denied",
      },
    })

    const cancelledRun = await waitForRunStatus(harness.server, runId, "cancelled")
    expect(cancelledRun.permissionRequests).toMatchObject([
      {
        id: permissionId,
        status: "denied",
      },
    ])
    await expect(readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).rejects.toThrow()
  })

  test("returns explicit HTTP errors for invalid-state cancel and unknown permission reply", async () => {
    const harness = await createHarness("server-http-errors", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "done" }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Finish quickly",
      },
    )
    const runId = startedRun.body.data.run.id as string
    await waitForRunStatus(harness.server, runId, "completed")

    const invalidCancel = await requestJson(harness.server, "POST", `/runs/${runId}/cancel`)
    expect(invalidCancel.status).toBe(409)
    expect(invalidCancel.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining("cannot transition"),
      },
    })

    const missingPermissionReply = await requestJson(
      harness.server,
      "POST",
      "/permissions/permission_missing/reply",
      {
        decision: "allow",
      },
    )
    expect(missingPermissionReply.status).toBe(404)
    expect(missingPermissionReply.body).toMatchObject({
      error: {
        code: "not_found",
        message: expect.stringContaining("Unknown permission_request"),
      },
    })
  })

  test("returns invalid_state for duplicate client-specified runId", async () => {
    const harness = await createHarness("server-duplicate-run-id", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "done" }
      },
    ]))
    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const first = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "First run",
      runId: "run_duplicate",
    })
    expect(first.status).toBe(201)
    await waitForRunStatus(harness.server, "run_duplicate", "completed")

    const second = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Second run",
      runId: "run_duplicate",
    })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Run id run_duplicate already exists",
      },
    })
  })

  test("workspace endpoints keep the desktop workspace and session contract covered without knowledge fields", async () => {
    const harness = await createHarness("server-workspace-contract", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Alpha refreshed." }
      },
    ]))
    const alphaRoot = join(harness.workspaceRoot, "alpha")
    const betaRoot = join(harness.workspaceRoot, "beta")
    const gammaRoot = join(harness.workspaceRoot, "gamma")
    await mkdir(join(alphaRoot, ".agents", "skills", "reviewer"), { recursive: true })
    await mkdir(join(alphaRoot, ".agents", "skills", "writer"), { recursive: true })
    await Bun.write(
      join(alphaRoot, ".agents", "skills", "reviewer", "SKILL.md"),
      ["name: reviewer", "description: Review carefully", "", "Focus on bugs first."].join("\n"),
    )
    await Bun.write(
      join(alphaRoot, ".agents", "skills", "writer", "SKILL.md"),
      ["name: writer", "description: Draft clearly", "", "Lead with the result."].join("\n"),
    )

    const alphaOneResponse = await requestJson(harness.server, "POST", "/workspace/sessions", {
      workspaceRoot: alphaRoot,
      title: "Alpha one",
    })
    expect(alphaOneResponse.status).toBe(201)
    const alphaOneSession = alphaOneResponse.body.data.session as Record<string, any>
    expectSessionContract(alphaOneSession, {
      directory: alphaRoot,
      workspaceRoot: alphaRoot,
      title: "Alpha one",
      latestUserMessagePreview: null,
      latestRunStatus: null,
    })

    const alphaTwoResponse = await requestJson(harness.server, "POST", "/workspace/sessions", {
      workspaceRoot: alphaRoot,
      title: "Alpha two",
    })
    expect(alphaTwoResponse.status).toBe(201)
    const alphaTwoSession = alphaTwoResponse.body.data.session as Record<string, any>
    expectSessionContract(alphaTwoSession, {
      directory: alphaRoot,
      workspaceRoot: alphaRoot,
      title: "Alpha two",
      latestUserMessagePreview: null,
      latestRunStatus: null,
    })

    const betaResponse = await requestJson(harness.server, "POST", "/workspace/sessions", {
      workspaceRoot: betaRoot,
      title: "Beta one",
    })
    expect(betaResponse.status).toBe(201)
    const betaSession = betaResponse.body.data.session as Record<string, any>
    expectSessionContract(betaSession, {
      directory: betaRoot,
      workspaceRoot: betaRoot,
      title: "Beta one",
      latestUserMessagePreview: null,
      latestRunStatus: null,
    })

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${alphaOneSession.id}/runs`,
      {
        prompt: "Refresh alpha project",
      },
    )
    expect(startedRun.status).toBe(201)
    const runId = startedRun.body.data.run.id as string
    await waitForRunStatus(harness.server, runId, "completed")

    const alphaSessionsResponse = await requestJson(
      harness.server,
      "GET",
      `/workspace/sessions?workspaceRoot=${encodeURIComponent(alphaRoot)}`,
    )
    expect(alphaSessionsResponse.status).toBe(200)
    expect(alphaSessionsResponse.body.data.sessions).toHaveLength(2)
    const [latestAlphaSession, olderAlphaSession] = alphaSessionsResponse.body.data.sessions as Array<
      Record<string, any>
    >
    expectSessionContract(latestAlphaSession, {
      id: alphaOneSession.id,
      directory: alphaRoot,
      workspaceRoot: alphaRoot,
      title: "Alpha one",
      latestUserMessagePreview: "Refresh alpha project",
      latestRunStatus: "completed",
    })
    expectSessionContract(olderAlphaSession, {
      id: alphaTwoSession.id,
      directory: alphaRoot,
      workspaceRoot: alphaRoot,
      title: "Alpha two",
      latestUserMessagePreview: null,
      latestRunStatus: null,
    })
    expect(latestAlphaSession.updatedAt).toBeGreaterThan(olderAlphaSession.updatedAt)

    const alphaSkillsResponse = await requestJson(
      harness.server,
      "GET",
      `/workspace/skills?workspaceRoot=${encodeURIComponent(alphaRoot)}`,
    )
    expect(alphaSkillsResponse.status).toBe(200)
    expect(alphaSkillsResponse.body.data.skills).toEqual([
      {
        name: "reviewer",
        description: "Review carefully",
        path: ".agents/skills/reviewer/SKILL.md",
      },
      {
        name: "writer",
        description: "Draft clearly",
        path: ".agents/skills/writer/SKILL.md",
      },
    ])

    const alphaWorkspaceResponse = await requestJson(
      harness.server,
      "GET",
      `/workspace?workspaceRoot=${encodeURIComponent(alphaRoot)}`,
    )
    expect(alphaWorkspaceResponse.status).toBe(200)
    const alphaWorkspace = alphaWorkspaceResponse.body.data.workspace as Record<string, any>
    expectWorkspaceContract(alphaWorkspace, {
      workspaceRoot: alphaRoot,
      name: "alpha",
      latestActivityAt: latestAlphaSession.updatedAt,
      sessionCount: 2,
    })
    expect(alphaWorkspace.sessions).toEqual(alphaSessionsResponse.body.data.sessions)

    const listedWorkspaces = await requestJson(harness.server, "GET", "/workspaces")
    expect(listedWorkspaces.status).toBe(200)
    expect(listedWorkspaces.body.data.workspaces).toHaveLength(2)
    const [firstWorkspace, secondWorkspace] = listedWorkspaces.body.data.workspaces as Array<
      Record<string, any>
    >
    expectWorkspaceContract(firstWorkspace, {
      workspaceRoot: alphaRoot,
      name: "alpha",
      latestActivityAt: latestAlphaSession.updatedAt,
      sessionCount: 2,
    })
    expect(firstWorkspace.sessions).toEqual(alphaSessionsResponse.body.data.sessions)
    expectWorkspaceContract(secondWorkspace, {
      workspaceRoot: betaRoot,
      name: "beta",
      latestActivityAt: betaSession.updatedAt,
      sessionCount: 1,
    })
    expect(secondWorkspace.sessions).toEqual([betaSession])

    const openedAlphaWorkspace = await requestJson(harness.server, "POST", "/workspaces/open", {
      directory: alphaRoot,
    })
    expect(openedAlphaWorkspace.status).toBe(200)
    expect(openedAlphaWorkspace.body.data.workspace).toEqual(alphaWorkspace)

    const openedEmptyWorkspace = await requestJson(harness.server, "POST", "/workspaces/open", {
      directory: gammaRoot,
      create: true,
    })
    expect(openedEmptyWorkspace.status).toBe(200)
    expectWorkspaceContract(openedEmptyWorkspace.body.data.workspace as Record<string, any>, {
      workspaceRoot: gammaRoot,
      name: "gamma",
      latestActivityAt: 0,
      sessionCount: 0,
    })
    expect(openedEmptyWorkspace.body.data.workspace.sessions).toEqual([])
  })

  test("deletes idle sessions atomically and rejects busy sessions", async () => {
    const harness = await createHarness(
      "server-session-delete",
      createTurnProvider([
        async function* () {
          yield { type: "text.delta", text: "Idle run completed." }
        },
        async function* (request) {
          yield { type: "text.delta", text: "Busy run started." }
          await new Promise<void>((resolve) => {
            request.signal.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      ]),
    )

    const idleSessionResponse = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
      title: "Idle session",
    })
    const idleSessionId = idleSessionResponse.body.data.session.id as string

    const busySessionResponse = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
      title: "Busy session",
    })
    const busySessionId = busySessionResponse.body.data.session.id as string

    const idleRunResponse = await requestJson(harness.server, "POST", `/sessions/${idleSessionId}/runs`, {
      prompt: "Finish and delete me",
    })
    const idleRunId = idleRunResponse.body.data.run.id as string
    await waitForRunStatus(harness.server, idleRunId, "completed")

    const busyRunResponse = await requestJson(harness.server, "POST", `/sessions/${busySessionId}/runs`, {
      prompt: "Keep the busy session alive",
    })
    const busyRunId = busyRunResponse.body.data.run.id as string
    await waitForRunStatus(harness.server, busyRunId, "running")

    const busyDeleteResponse = await requestJson(harness.server, "DELETE", `/sessions/${busySessionId}`)
    expect(busyDeleteResponse.status).toBe(409)
    expect(busyDeleteResponse.body).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringContaining(`Session ${busySessionId} already has active run`),
      },
    })

    const idleDeleteResponse = await requestJson(harness.server, "DELETE", `/sessions/${idleSessionId}`)
    expect(idleDeleteResponse.status).toBe(200)
    expect(idleDeleteResponse.body.data).toEqual({
      sessionId: idleSessionId,
    })

    const deletedRunEvents = harness.database
      .query("SELECT COUNT(*) AS count FROM run_event WHERE session_id = ?")
      .get(idleSessionId) as { count: number } | null
    expect(deletedRunEvents?.count ?? 0).toBe(0)

    const missingSessionState = await requestJson(harness.server, "GET", `/sessions/${idleSessionId}`)
    expect(missingSessionState.status).toBe(404)
    expect(missingSessionState.body.error.message).toContain(`Unknown session: ${idleSessionId}`)

    const removedTrace = await requestJson(harness.server, "GET", `/runs/${idleRunId}/trace`)
    expect(removedTrace.status).toBe(404)
    expect(removedTrace.body.error.message).toContain(`Unknown run: ${idleRunId}`)

    const remainingSessions = await requestJson(harness.server, "GET", "/sessions")
    expect(remainingSessions.status).toBe(200)
    expect(remainingSessions.body.data.sessions).toHaveLength(1)
    expect(remainingSessions.body.data.sessions[0]).toMatchObject({
      id: busySessionId,
    })

    await restartHarness(harness, createTurnProvider([]))

    const remainingSessionsAfterRestart = await requestJson(harness.server, "GET", "/sessions")
    expect(remainingSessionsAfterRestart.status).toBe(200)
    expect(remainingSessionsAfterRestart.body.data.sessions).toHaveLength(1)
    expect(remainingSessionsAfterRestart.body.data.sessions[0]).toMatchObject({
      id: busySessionId,
    })

    const removedTraceAfterRestart = await requestJson(harness.server, "GET", `/runs/${idleRunId}/trace`)
    expect(removedTraceAfterRestart.status).toBe(404)
    expect(removedTraceAfterRestart.body.error.message).toContain(`Unknown run: ${idleRunId}`)
  })

  test("emits a session.deleted SSE event when a session is removed", async () => {
    const harness = await createHarness("server-session-delete-sse", createTurnProvider([]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
      title: "Delete over SSE",
    })
    const sessionId = createdSession.body.data.session.id as string

    const subscriber = await connectSse(harness.server)
    await subscriber.next((event) => event.event === "heartbeat")

    const deleteResponse = await requestJson(harness.server, "DELETE", `/sessions/${sessionId}`)
    expect(deleteResponse.status).toBe(200)

    expect(await subscriber.next((event) => event.event === "session.deleted")).toMatchObject({
      event: "session.deleted",
      data: {
        type: "session.deleted",
        sessionId,
        workspaceRoot: harness.workspaceRoot,
      },
    })

    await subscriber.close()
  })

  test("skill state endpoints update session defaults but do not expose run-level mutation", async () => {
    const harness = await createHarness("server-skill-state-update", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "Skill state updated." }
      },
    ]))
    await mkdir(join(harness.workspaceRoot, ".agents", "skills", "reviewer"), { recursive: true })
    await mkdir(join(harness.workspaceRoot, ".agents", "skills", "writer"), { recursive: true })
    await Bun.write(
      join(harness.workspaceRoot, ".agents", "skills", "reviewer", "SKILL.md"),
      ["name: reviewer", "description: Review carefully", "", "Focus on bugs first."].join("\n"),
    )
    await Bun.write(
      join(harness.workspaceRoot, ".agents", "skills", "writer", "SKILL.md"),
      ["name: writer", "description: Draft clearly", "", "Lead with the result."].join("\n"),
    )

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
      title: "Skill session",
    })
    expect(createdSession.status).toBe(201)
    const sessionId = createdSession.body.data.session.id as string

    const updatedSession = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/active-skills`,
      {
        activeSkills: [" reviewer ", "writer", "reviewer"],
      },
    )
    expect(updatedSession.status).toBe(200)
    expect(updatedSession.body.data.session.activeSkills).toEqual(["reviewer", "writer"])

    const sessionState = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionState.status).toBe(200)
    expect(sessionState.body.data.session.activeSkills).toEqual(["reviewer", "writer"])

    const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Update skill state",
      runId: "run_skill_state_update",
    })
    expect(startedRun.status).toBe(201)
    expect(startedRun.body.data.run.activeSkills).toEqual(["reviewer", "writer"])
    await waitForRunStatus(harness.server, "run_skill_state_update", "completed")

    const updatedRun = await requestJson(harness.server, "POST", "/runs/run_skill_state_update/active-skills", {
      activeSkills: ["writer"],
    })
    expect(updatedRun.status).toBe(404)
    expect(updatedRun.body.error).toMatchObject({
      code: "not_found",
      message: "Unknown route: POST /runs/run_skill_state_update/active-skills",
    })

    const runState = await requestJson(harness.server, "GET", "/runs/run_skill_state_update")
    expect(runState.status).toBe(200)
    expect(runState.body.data.run.activeSkills).toEqual(["reviewer", "writer"])

    const sessionStateAfterRunUpdate = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionStateAfterRunUpdate.status).toBe(200)
    expect(sessionStateAfterRunUpdate.body.data.session.activeSkills).toEqual(["reviewer", "writer"])
  })

  test("rejects session skill updates while a run is active", async () => {
    const harness = await createHarness("server-skill-state-busy", createTurnProvider([
      async function* () {
        await Bun.sleep(50)
        yield { type: "text.delta", text: "Busy run finished." }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
      title: "Busy skill session",
    })
    const sessionId = createdSession.body.data.session.id as string

    const startedRun = await requestJson(harness.server, "POST", `/sessions/${sessionId}/runs`, {
      prompt: "Hold the session busy",
      runId: "run_busy_skill_update",
    })
    expect(startedRun.status).toBe(201)

    const rejectedUpdate = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/active-skills`,
      {
        activeSkills: ["reviewer"],
      },
    )
    expect(rejectedUpdate.status).toBe(409)
    expect(rejectedUpdate.body.error).toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining(`Session ${sessionId}`),
    })

    await waitForRunStatus(harness.server, "run_busy_skill_update", "completed")

    const sessionState = await requestJson(harness.server, "GET", `/sessions/${sessionId}`)
    expect(sessionState.status).toBe(200)
    expect(sessionState.body.data.session.activeSkills).toEqual([])
  })

  test("a reconnecting client can refetch final state without historical SSE replay", async () => {
    const harness = await createHarness("server-reconnect", createTurnProvider([
      async function* () {
        yield { type: "text.delta", text: "first " }
        await Bun.sleep(40)
        yield { type: "text.delta", text: "second" }
      },
    ]))

    const createdSession = await requestJson(harness.server, "POST", "/sessions", {
      directory: harness.workspaceRoot,
    })
    const sessionId = createdSession.body.data.session.id as string

    const subscriberA = await connectSse(harness.server)
    await subscriberA.next((event) => event.event === "heartbeat")

    const startedRun = await requestJson(
      harness.server,
      "POST",
      `/sessions/${sessionId}/runs`,
      {
        prompt: "Reconnect me",
      },
    )
    const runId = startedRun.body.data.run.id as string

    await subscriberA.next((event) => event.event === "run.updated" && event.data.run.status === "running")
    await subscriberA.close()

    await waitForRunStatus(harness.server, runId, "completed")

    const subscriberB = await connectSse(harness.server)
    expect(await subscriberB.next((event) => event.event === "heartbeat")).toMatchObject({
      event: "heartbeat",
      data: {
        type: "heartbeat",
      },
    })

    const finalRun = await requestJson(harness.server, "GET", `/runs/${runId}`)
    expect(finalRun.status).toBe(200)
    expect(finalRun.body.data.run).toMatchObject({
      id: runId,
      status: "completed",
    })

    const transcript = await requestJson(harness.server, "GET", `/sessions/${sessionId}/transcript`)
    expect(transcript.status).toBe(200)
    expect(transcript.body.data.transcript).toMatchObject([
      {
        runId,
        role: "user",
        parts: [{ kind: "text", text: "Reconnect me" }],
      },
      {
        runId,
        role: "assistant",
        parts: [{ kind: "text", text: "first second" }],
      },
    ])

    await subscriberB.close()
  })
})

async function createHarness(
  prefix: string,
  provider: OrchestrationModelPort,
  options: {
    permissionPolicy?: Partial<Record<"write" | "edit" | "shell", "allow" | "ask" | "deny">>
    repositoryFactory?(repository: SessionRepository): SessionRepository
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")

  const databasePath = join(directory, "agent.sqlite")
  const database = openStorageDatabase(databasePath)
  openDatabases.push(database)

  const now = createMonotonicClock()
  const baseRepository = createStorageRepository({
    database,
    now,
  })
  const repository = options.repositoryFactory
    ? options.repositoryFactory(baseRepository)
    : baseRepository
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
  const skillRuntime = createWorkspaceSkillRuntime()
  const server = createAgentServer({
    createRuntimeImpl(runtimeInput) {
      return createRuntime({
        provider,
        repository: runtimeInput.repository,
        permissionRepository: runtimeInput.permissionRepository,
        observability,
        permissionPolicy: options.permissionPolicy,
        now: runtimeInput.now,
      })
    },
    repository,
    permissionRepository,
    exportRunTraceImpl: observability.exportRunTrace,
    listSkillCatalogImpl(workspaceRoot) {
      return skillRuntime.listCatalog(workspaceRoot)
    },
    deleteSessionImpl: createSessionDeletionCoordinator({
      database,
      repository,
    }).deleteSession,
    now,
    heartbeatIntervalMs: 15,
  })
  activeServers.push(server)

  return {
    databasePath,
    database,
    workspaceRoot,
    server,
    repository,
    permissionRepository,
    now,
  }
}

async function restartHarness(
  harness: {
    databasePath: string
    database: ReturnType<typeof openStorageDatabase>
    now: () => number
    server: { stop(): Promise<void> | void }
    repository: SessionRepository
    permissionRepository: ReturnType<typeof createPermissionRepository>
  },
  provider: OrchestrationModelPort,
  options: {
    permissionPolicy?: Partial<Record<"write" | "edit" | "shell", "allow" | "ask" | "deny">>
  } = {},
) {
  await harness.server.stop()
  activeServers.pop()
  openDatabases.pop()?.close(false)

  const reopenedDatabase = openStorageDatabase(harness.databasePath)
  openDatabases.push(reopenedDatabase)

  const reopenedRepository = createStorageRepository({
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
  const skillRuntime = createWorkspaceSkillRuntime()
  const reopenedServer = createAgentServer({
    createRuntimeImpl(runtimeInput) {
      return createRuntime({
        provider,
        repository: runtimeInput.repository,
        permissionRepository: runtimeInput.permissionRepository,
        observability: reopenedObservability,
        permissionPolicy: options.permissionPolicy,
        now: runtimeInput.now,
      })
    },
    repository: reopenedRepository,
    permissionRepository: reopenedPermissionRepository,
    exportRunTraceImpl: reopenedObservability.exportRunTrace,
    listSkillCatalogImpl(workspaceRoot) {
      return skillRuntime.listCatalog(workspaceRoot)
    },
    deleteSessionImpl: createSessionDeletionCoordinator({
      database: reopenedDatabase,
      repository: reopenedRepository,
    }).deleteSession,
    now: harness.now,
    heartbeatIntervalMs: 15,
  })
  activeServers.push(reopenedServer)

  harness.database = reopenedDatabase
  harness.server = reopenedServer
  harness.repository = reopenedRepository
  harness.permissionRepository = reopenedPermissionRepository
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

type SseEnvelope = {
  event: string
  data: Record<string, any>
}

async function connectSse(server: { fetch(request: Request): Promise<Response> | Response }) {
  const response = await server.fetch(
    new Request("http://server.test/events", {
      headers: {
        accept: "text/event-stream",
      },
    }),
  )

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(response.body).not.toBeNull()

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const queue: SseEnvelope[] = []
  let buffer = ""
  let closed = false
  let waiter: (() => void) | null = null

  const pump = (async () => {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        closed = true
        waiter?.()
        waiter = null
        return
      }

      buffer += decoder.decode(next.value, { stream: true })

      while (true) {
        const delimiterIndex = buffer.indexOf("\n\n")
        if (delimiterIndex === -1) {
          break
        }

        const block = buffer.slice(0, delimiterIndex)
        buffer = buffer.slice(delimiterIndex + 2)

        const parsed = parseSseBlock(block)
        if (!parsed) {
          continue
        }

        queue.push(parsed)
        waiter?.()
        waiter = null
      }
    }
  })()

  return {
    async next(
      predicate: (event: SseEnvelope) => boolean = () => true,
      timeoutMs = 2_000,
    ) {
      const startedAt = Date.now()

      while (Date.now() - startedAt < timeoutMs) {
        const matchedIndex = queue.findIndex(predicate)
        if (matchedIndex !== -1) {
          return queue.splice(matchedIndex, 1)[0] as SseEnvelope
        }

        if (closed) {
          throw new Error("SSE stream closed before the expected event arrived")
        }

        await Promise.race([
          new Promise<void>((resolve) => {
            waiter = resolve
          }),
          Bun.sleep(20),
        ])
      }

      throw new Error("Timed out waiting for SSE event")
    },
    async close() {
      closed = true
      await reader.cancel()
      await pump
    },
  }
}

function parseSseBlock(block: string): SseEnvelope | null {
  if (!block.trim()) {
    return null
  }

  let event = "message"
  const dataLines: string[] = []

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim()
      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim())
    }
  }

  return {
    event,
    data: JSON.parse(dataLines.join("\n")),
  }
}

async function collectEventsUntil(
  subscriber: {
    next(predicate?: (event: SseEnvelope) => boolean, timeoutMs?: number): Promise<SseEnvelope>
  },
  predicate: (event: SseEnvelope) => boolean,
) {
  const events: SseEnvelope[] = []

  while (true) {
    const event = await subscriber.next()
    events.push(event)

    if (predicate(event)) {
      return events
    }
  }
}

function simplifyRelevantEvents(events: SseEnvelope[], runId: string) {
  return events
    .filter((event) =>
      event.event === "run.updated" ||
      event.event === "message.part.updated",
    )
    .filter((event) =>
      event.event === "run.updated"
        ? event.data.run.id === runId
        : event.data.part.runId === runId,
    )
    .map((event) => {
      if (event.event === "run.updated") {
        return {
          event: event.event,
          id: event.data.run.id,
          status: event.data.run.status,
        }
      }

      return {
        event: event.event,
        id: event.data.part.id,
        kind: event.data.part.kind,
      }
    })
}

function createTurnProvider(
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
){
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

function createMonotonicClock(start = 1_000) {
  let current = start

  return () => {
    current += 1
    return current
  }
}

const desktopWorkspaceKeys = [
  "latestActivityAt",
  "name",
  "sessionCount",
  "sessions",
  "workspaceRoot",
]

const desktopSessionKeys = [
  "activeSkills",
  "createdAt",
  "directory",
  "id",
  "latestRunStatus",
  "latestUserMessagePreview",
  "title",
  "updatedAt",
  "workspaceRoot",
]

function expectWorkspaceContract(
  workspace: Record<string, any>,
  expected: Partial<Record<string, unknown>>,
) {
  expect(Object.keys(workspace).sort()).toEqual(desktopWorkspaceKeys)
  expect(typeof workspace.workspaceRoot).toBe("string")
  expect(typeof workspace.name).toBe("string")
  expect(typeof workspace.latestActivityAt).toBe("number")
  expect(typeof workspace.sessionCount).toBe("number")
  expect(Array.isArray(workspace.sessions)).toBe(true)
  expect(workspace).toMatchObject(expected)
}

function expectSessionContract(
  session: Record<string, any>,
  expected: Partial<Record<string, unknown>>,
) {
  expect(Object.keys(session).sort()).toEqual(desktopSessionKeys)
  expect(typeof session.id).toBe("string")
  expect(typeof session.directory).toBe("string")
  expect(typeof session.workspaceRoot).toBe("string")
  expect(typeof session.createdAt).toBe("number")
  expect(typeof session.title).toBe("string")
  expect(typeof session.updatedAt).toBe("number")
  expect(
    session.latestUserMessagePreview === null ||
      typeof session.latestUserMessagePreview === "string",
  ).toBe(true)
  expect(
    session.latestRunStatus === null ||
      ["queued", "running", "waiting_permission", "completed", "failed", "cancelled"].includes(
        session.latestRunStatus,
      ),
  ).toBe(true)
  expect(Array.isArray(session.activeSkills)).toBe(true)
  expect(session.activeSkills.every((activeSkill: unknown) => typeof activeSkill === "string")).toBe(
    true,
  )
  expect(session).toMatchObject(expected)
}
