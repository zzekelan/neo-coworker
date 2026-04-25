import { afterEach, describe, expect, test } from "bun:test"
import { access, cp, mkdir, mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionRunService } from "../../src/session"
import {
  createModelRuntimeApi,
  type ProviderEvent,
  type ProviderTurnRequest,
  createModelProvider,
} from "../../src/model"
import type { OrchestrationModelPort, OrchestrationRuntimeEvent } from "../../src/orchestration"
import {
  createRuntime,
  PermissionRequestNotPendingError,
} from "../../src/bootstrap"
import {
  PermissionNotFoundError,
  createPermissionRepository,
  type PermissionResponse,
} from "../../src/permission"
import { buildToolDeniedMessage } from "../../src/agent/application/tool-permission-check"
import {
  createSessionRepository as createStorageRepository,
  openSessionDatabase as openStorageDatabase,
  type SessionRepository as StorageRepository,
} from "../../src/session"

const tempDirectories: string[] = []
const openDatabases: Array<{ close: (throwOnError: boolean) => void }> = []

declare global {
  const Bun: {
    write(path: string | URL, data: string): Promise<number>
    sleep(milliseconds: number): Promise<void>
  }
}

type PermissionRequestedEvent = Extract<OrchestrationRuntimeEvent, { type: "permission.requested" }>

type RuntimeController = ReturnType<typeof createRuntime> & {
  respondPermission(input: PermissionResponse): void
  cancelRun(runId: string): void
}

afterEach(async () => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close(false)
  }

  while (tempDirectories.length > 0) {
    await rm(tempDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("runtime permission flow", () => {
  test("lists the plan_exit tool for main-agent runs", async () => {
    const harness = await createHarness("plan-exit-listed", false)
    const requests: ProviderTurnRequest[] = []
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_plan_exit_listed",
      messageId: "message_plan_exit_listed_user",
      prompt: "List tools",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* (request) {
          expect(request.tools.map((tool) => tool.name)).toContain("plan_exit")
          yield { type: "text.delta", text: "Tool list checked." }
        },
      ]),
      harness,
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })

    await collectEvents(handle.events[Symbol.asyncIterator]())

    expect(requests).toHaveLength(1)
  })

  test("plan mode keeps skill write tools visible but denies create_skill before execution", async () => {
    const harness = await createHarness("plan-skill-write-denied", false)
    harness.service.setSessionCurrentAgent(harness.session.id, "plan")
    const requests: ProviderTurnRequest[] = []
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_plan_skill_write_denied",
      messageId: "message_plan_skill_write_denied_user",
      prompt: "Create a reusable skill",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* (request) {
          expect(request.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["create_skill", "patch_skill", "delete_skill", "plan_exit"]),
          )
          yield {
            type: "tool.call",
            callId: "call_plan_create_skill_denied",
            name: "create_skill",
            inputText: JSON.stringify({
              name: "reviewer",
              frontmatter: {
                description: "Review changes",
              },
              content: "Focus on regressions first.",
            }),
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Stayed read-only." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "allow",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })

    await collectEvents(handle.events[Symbol.asyncIterator]())

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(2)
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toEqual([])
    expect(harness.repository.sessions.getCurrentAgent(harness.session.id)).toBe("plan")
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_plan_create_skill_denied",
          toolName: "create_skill",
        },
      },
      {
        kind: "tool_result",
        text: buildToolDeniedMessage("create_skill", "plan"),
        data: {
          callId: "call_plan_create_skill_denied",
          toolName: "create_skill",
          output: buildToolDeniedMessage("create_skill", "plan"),
          isError: true,
        },
      },
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Stayed read-only." }])
    expect(readToolResultParts(requests[1]!)).toEqual([
      expect.objectContaining({
        toolName: "create_skill",
        isError: true,
        output: buildToolDeniedMessage("create_skill", "plan"),
      }),
    ])
    expect(await fileExists(join(harness.workspaceRoot, ".ncoworker", "skills", "reviewer", "SKILL.md"))).toBe(
      false,
    )
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("plan_exit returns an immediate tool error when not in plan mode", async () => {
    const harness = await createHarness("plan-exit-wrong-mode", false)
    const requests: ProviderTurnRequest[] = []
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_plan_exit_wrong_mode",
      messageId: "message_plan_exit_wrong_mode_user",
      prompt: "Exit plan mode",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_plan_exit_wrong_mode",
            name: "plan_exit",
            inputText: '{"reason":"done planning"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Still on general agent." }
        },
      ]),
      harness,
      permissionPolicy: {
        plan_exit: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })

    await collectEvents(handle.events[Symbol.asyncIterator]())

    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toEqual([])
    expect(harness.repository.sessions.getCurrentAgent(harness.session.id)).toBe("general")
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_plan_exit_wrong_mode",
          toolName: "plan_exit",
        },
      },
      {
        kind: "tool_result",
        text: "Not in plan mode.",
        data: {
          callId: "call_plan_exit_wrong_mode",
          toolName: "plan_exit",
          output: "Not in plan mode.",
          isError: true,
        },
      },
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Still on general agent." }])
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
    expect(requests).toHaveLength(2)
  })

  test("approval switches the session from plan mode back to general", async () => {
    const harness = await createHarness("plan-exit-approve", false)
    harness.service.setSessionCurrentAgent(harness.session.id, "plan")
    const requests: ProviderTurnRequest[] = []
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_plan_exit_approve",
      messageId: "message_plan_exit_approve_user",
      prompt: "Leave plan mode",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_plan_exit_approve",
            name: "plan_exit",
            inputText: '{"reason":"implementation is ready"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Returned to general." }
        },
      ]),
      harness,
      permissionPolicy: {
        plan_exit: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    expect(permissionEvent.reason).toBe("exit plan mode: implementation is ready")
    expect(harness.repository.runs.get(started.run.id).status).toBe("waiting_permission")
    expect(harness.repository.sessions.getCurrentAgent(harness.session.id)).toBe("plan")

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    const remainingEvents = await collectEvents(iterator)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(harness.repository.sessions.getCurrentAgent(harness.session.id)).toBe("general")
    expect(harness.permissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      toolName: "plan_exit",
      status: "approved",
    })
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_plan_exit_approve",
          toolName: "plan_exit",
        },
      },
      {
        kind: "tool_result",
        text: "Switched back to general mode.",
        data: {
          callId: "call_plan_exit_approve",
          toolName: "plan_exit",
          output: "Switched back to general mode.",
        },
      },
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Returned to general." }])
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
  })

  test("denial leaves the session in plan mode and cancels the run", async () => {
    const harness = await createHarness("plan-exit-deny", false)
    harness.service.setSessionCurrentAgent(harness.session.id, "plan")
    const requests: ProviderTurnRequest[] = []
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_plan_exit_deny",
      messageId: "message_plan_exit_deny_user",
      prompt: "Try to leave plan mode",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_plan_exit_deny",
            name: "plan_exit",
            inputText: '{}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "This should not run." }
        },
      ]),
      harness,
      permissionPolicy: {
        plan_exit: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "deny",
    })

    const remainingEvents = await collectEvents(iterator)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(harness.repository.sessions.getCurrentAgent(harness.session.id)).toBe("plan")
    expect(harness.permissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      toolName: "plan_exit",
      status: "denied",
    })
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual(["tool_call", "error"])
    expect(activeRunMessages[1]?.parts[1]).toMatchObject({
      kind: "error",
      text: "Tool plan_exit failed: Permission denied",
      data: {
        source: "tool",
        callId: "call_plan_exit_deny",
        toolName: "plan_exit",
      },
    })
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.cancelled",
      runId: started.run.id,
    })
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
    expect(requests).toHaveLength(1)
  })

  test("approval resumes the same run for webfetch after waiting permission", async () => {
    const harness = await createHarness("permission-webfetch", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_webfetch",
      messageId: "message_permission_webfetch_user",
      prompt: "Fetch a note from the web",
    })
    const requests: ProviderTurnRequest[] = []
    const url = "data:text/plain,Hello%20from%20webfetch."
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_webfetch",
            name: "webfetch",
            inputText: `{"url":"${url}"}`,
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Fetch finished." }
        },
      ]),
      harness,
      permissionPolicy: {
        webfetch: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    expect(permissionEvent.reason).toBe(`webfetch ${url}`)
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "waiting_permission",
    })

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    const remainingEvents = await collectEvents(iterator)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(2)
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_webfetch",
          toolName: "webfetch",
        },
      },
      {
        kind: "tool_result",
        text: "Hello from webfetch.",
        data: {
          callId: "call_webfetch",
          toolName: "webfetch",
          output: "Hello from webfetch.",
        },
      },
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Fetch finished." }])
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
  })

  test("the first reply keeps a run waiting while another permission request is still pending", async () => {
    const harness = await createHarness("permission-webfetch-multi-pending", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_webfetch_multi_pending",
      messageId: "message_permission_webfetch_multi_pending_user",
      prompt: "Fetch two notes from the web",
    })
    const requests: ProviderTurnRequest[] = []
    const firstUrl = "data:text/plain,Hello%20from%20the%20first%20fetch."
    const secondUrl = "data:text/plain,Hello%20from%20the%20second%20fetch."
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_webfetch_1",
            name: "webfetch",
            inputText: `{"url":"${firstUrl}"}`,
          }
          yield {
            type: "tool.call",
            callId: "call_webfetch_2",
            name: "webfetch",
            inputText: `{"url":"${secondUrl}"}`,
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Both fetches finished." }
        },
      ]),
      harness,
      permissionPolicy: {
        webfetch: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const firstPermissionEvent = await waitForPermissionRequestWithin(iterator, 250)
    const secondPermissionEvent = await waitForPermissionRequestWithin(iterator, 250)

    expect(firstPermissionEvent.requestId).not.toBe(secondPermissionEvent.requestId)
    expect([firstPermissionEvent.reason, secondPermissionEvent.reason].sort()).toEqual(
      [`webfetch ${firstUrl}`, `webfetch ${secondUrl}`].sort(),
    )
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "waiting_permission",
    })
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toMatchObject([
      {
        id: firstPermissionEvent.requestId,
        toolName: "webfetch",
        status: "pending",
      },
      {
        id: secondPermissionEvent.requestId,
        toolName: "webfetch",
        status: "pending",
      },
    ])

    runtime.respondPermission({
      requestId: secondPermissionEvent.requestId,
      decision: "allow",
    })

    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "waiting_permission",
    })
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toMatchObject([
      {
        id: firstPermissionEvent.requestId,
        status: "pending",
      },
      {
        id: secondPermissionEvent.requestId,
        status: "approved",
      },
    ])

    runtime.respondPermission({
      requestId: firstPermissionEvent.requestId,
      decision: "allow",
    })

    const remainingEvents = await collectEvents(iterator)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(requests).toHaveLength(2)
    expect(activeRunMessages[1]?.parts).toMatchObject([
      {
        kind: "tool_call",
        data: {
          callId: "call_webfetch_1",
          toolName: "webfetch",
        },
      },
      {
        kind: "tool_call",
        data: {
          callId: "call_webfetch_2",
          toolName: "webfetch",
        },
      },
      {
        kind: "tool_result",
        text: "Hello from the first fetch.",
        data: {
          callId: "call_webfetch_1",
          toolName: "webfetch",
          output: "Hello from the first fetch.",
        },
      },
      {
        kind: "tool_result",
        text: "Hello from the second fetch.",
        data: {
          callId: "call_webfetch_2",
          toolName: "webfetch",
          output: "Hello from the second fetch.",
        },
      },
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Both fetches finished." }])
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("approval resumes the same run after waiting permission", async () => {
    const harness = await createHarness("permission-allow", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_allow",
      messageId: "message_permission_allow_user",
      prompt: "Write notes.txt",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Preparing write." }
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    expect(permissionEvent.reason).toBe("write notes.txt")
    expect(requests).toHaveLength(1)
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "waiting_permission",
    })
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toMatchObject([
      {
        id: permissionEvent.requestId,
        sessionId: harness.session.id,
        runId: started.run.id,
        toolName: "write",
        status: "pending",
      },
    ])

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    const remainingEvents = await collectEvents(iterator)
    const transcript = harness.repository.messages.listSessionTranscript(harness.session.id)
    const activeRunMessages = transcript.filter((message) => message.runId === started.run.id)

    expect(await readFile(join(harness.workspaceRoot, "notes.txt"), "utf8")).toBe("hello")
    expect(requests).toHaveLength(2)
    expect(activeRunMessages).toHaveLength(3)
    expect(activeRunMessages[1]?.parts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ])
    expect(activeRunMessages[2]?.parts).toMatchObject([{ kind: "text", text: "Write finished." }])
    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.completed",
      runId: started.run.id,
    })
    expect(harness.permissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "approved",
    })
    expect(harness.repository.runs.listBySession(harness.session.id)).toHaveLength(1)
    expect(harness.repository.runs.get(started.run.id).status).toBe("completed")
  })

  test("denial does not execute the tool side effect and cancels the run", async () => {
    const harness = await createHarness("permission-deny", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_deny",
      messageId: "message_permission_deny_user",
      prompt: "Try to write notes.txt and recover",
    })
    const requests: ProviderTurnRequest[] = []
    const runtime = createPermissionRuntime({
      provider: createTurnProvider(requests, [
        async function* () {
          yield { type: "text.delta", text: "Trying to write notes.txt." }
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Permission denial handled." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "deny",
    })

    await collectEvents(iterator)

    expect(await fileExists(join(harness.workspaceRoot, "notes.txt"))).toBe(false)
    expect(requests).toHaveLength(1)
    expect(harness.permissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "denied",
    })
    expect(harness.repository.runs.get(started.run.id).status).toBe("cancelled")
  })

  test("duplicate approval does not execute the tool twice", async () => {
    const harness = await createHarness("permission-duplicate", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_duplicate",
      messageId: "message_permission_duplicate_user",
      prompt: "Append once to counter.txt",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_shell",
            name: "shell",
            inputText: `{"command":"printf '1' >> counter.txt"}`,
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Counter updated." }
        },
      ]),
      harness,
      permissionPolicy: {
        shell: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.respondPermission({
      requestId: permissionEvent.requestId,
      decision: "allow",
    })

    expect(() =>
      runtime.respondPermission({
        requestId: permissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(/not pending/i)

    await collectEvents(iterator)

    expect(await readFile(join(harness.workspaceRoot, "counter.txt"), "utf8")).toBe("1")
    expect(harness.permissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "approved",
    })
  })

  test("cancellation while waiting finalizes the request and run", async () => {
    const harness = await createHarness("permission-cancel", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_cancel",
      messageId: "message_permission_cancel_user",
      prompt: "Try to write notes.txt",
    })
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    runtime.cancelRun(started.run.id)

    const remainingEvents = await collectEvents(iterator)

    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.cancelled",
      runId: started.run.id,
    })
    expect(await fileExists(join(harness.workspaceRoot, "notes.txt"))).toBe(false)
    expect(harness.permissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "cancelled",
      resolvedAt: expect.any(Number),
    })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "cancelled",
      finishedAt: expect.any(Number),
    })
    expect(() =>
      runtime.respondPermission({
        requestId: permissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(/not pending|cancelled/i)
  })

  test("cancelling a run with multiple pending permission requests finalizes every pending request", async () => {
    const harness = await createHarness("permission-cancel-multi", false)
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_cancel_multi",
      messageId: "message_permission_cancel_multi_user",
      prompt: "Try two web fetches and then cancel",
    })
    const firstUrl = "data:text/plain,Hello%20from%20the%20first%20cancelled%20fetch."
    const secondUrl = "data:text/plain,Hello%20from%20the%20second%20cancelled%20fetch."
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_webfetch_cancel_1",
            name: "webfetch",
            inputText: `{"url":"${firstUrl}"}`,
          }
          yield {
            type: "tool.call",
            callId: "call_webfetch_cancel_2",
            name: "webfetch",
            inputText: `{"url":"${secondUrl}"}`,
          }
        },
      ]),
      harness,
      permissionPolicy: {
        webfetch: "ask",
      },
    })

    const handle = await runtime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const firstPermissionEvent = await waitForPermissionRequestWithin(iterator, 250)
    const secondPermissionEvent = await waitForPermissionRequestWithin(iterator, 250)

    runtime.cancelRun(started.run.id)

    const remainingEvents = await collectEvents(iterator)

    expect(remainingEvents.at(-1)).toMatchObject({
      type: "run.cancelled",
      runId: started.run.id,
    })
    expect(harness.repository.runs.get(started.run.id)).toMatchObject({
      id: started.run.id,
      status: "cancelled",
      finishedAt: expect.any(Number),
    })
    expect(harness.permissionRepository.requests.listByRun(started.run.id)).toMatchObject([
      {
        id: firstPermissionEvent.requestId,
        status: "cancelled",
        resolvedAt: expect.any(Number),
      },
      {
        id: secondPermissionEvent.requestId,
        status: "cancelled",
        resolvedAt: expect.any(Number),
      },
    ])
    expect(() =>
      runtime.respondPermission({
        requestId: firstPermissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(/not pending|cancelled/i)
    expect(() =>
      runtime.respondPermission({
        requestId: secondPermissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(/not pending|cancelled/i)
  })

  test("permission request ids stay unique across approval-gated runs", async () => {
    const harness = await createHarness("permission-unique", false)
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_1",
            name: "write",
            inputText: '{"path":"first.txt","content":"first"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "First done." }
        },
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_2",
            name: "write",
            inputText: '{"path":"second.txt","content":"second"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Second done." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })

    const firstRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_unique_1",
      messageId: "message_permission_unique_1_user",
      prompt: "Write first.txt",
    })
    const firstHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: firstRun.run.id,
    })
    const firstIterator = firstHandle.events[Symbol.asyncIterator]()
    const firstPermission = await waitForPermissionRequest(firstIterator)

    runtime.respondPermission({
      requestId: firstPermission.requestId,
      decision: "allow",
    })
    await collectEvents(firstIterator)

    const secondRun = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_unique_2",
      messageId: "message_permission_unique_2_user",
      prompt: "Write second.txt",
    })
    const secondHandle = await runtime.run({
      sessionId: harness.session.id,
      runId: secondRun.run.id,
    })
    const secondIterator = secondHandle.events[Symbol.asyncIterator]()
    const secondPermission = await waitForPermissionRequest(secondIterator)

    expect(secondPermission.requestId).not.toBe(firstPermission.requestId)

    runtime.respondPermission({
      requestId: secondPermission.requestId,
      decision: "allow",
    })
    await collectEvents(secondIterator)

    expect(harness.permissionRepository.requests.listByRun(firstRun.run.id)).toMatchObject([
      { id: firstPermission.requestId, status: "approved" },
    ])
    expect(harness.permissionRepository.requests.listByRun(secondRun.run.id)).toMatchObject([
      { id: secondPermission.requestId, status: "approved" },
    ])
  })

  test("a fresh runtime instance cannot reply to a pending request after the active runtime is gone", async () => {
    const harness = await createHarness("permission-reopen-reply", false)
    const firstRuntime = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write",
            name: "write",
            inputText: '{"path":"notes.txt","content":"hello"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      harness,
      permissionPolicy: {
        write: "ask",
      },
    })
    const started = startPromptRun({
      repository: harness.repository,
      service: harness.service,
      sessionId: harness.session.id,
      runId: "run_permission_reopen_reply",
      messageId: "message_permission_reopen_reply_user",
      prompt: "Write notes.txt",
    })

    const handle = await firstRuntime.run({
      sessionId: harness.session.id,
      runId: started.run.id,
    })
    const iterator = handle.events[Symbol.asyncIterator]()
    const permissionEvent = await waitForPermissionRequest(iterator)

    firstRuntime.cancelRun(started.run.id)
    await collectEvents(iterator)

    const reopenedDatabase = trackDatabase(openStorageDatabase(harness.databasePath))
    const reopenedRepository = createStorageRepository({
      database: reopenedDatabase,
      now: harness.now,
    })
    const reopenedPermissionRepository = createPermissionRepository({
      database: reopenedDatabase,
      now: harness.now,
    })
    const secondRuntime = createRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield { type: "text.delta", text: "Write finished." }
        },
      ]),
      repository: reopenedRepository,
      permissionRepository: reopenedPermissionRepository,
      now: harness.now,
      permissionPolicy: {
        write: "ask",
      },
    }) as RuntimeController

    expect(() =>
      secondRuntime.respondPermission({
        requestId: permissionEvent.requestId,
        decision: "allow",
      }),
    ).toThrow(PermissionRequestNotPendingError)

    expect(await fileExists(join(harness.workspaceRoot, "notes.txt"))).toBe(false)
    expect(reopenedRepository.runs.get(started.run.id).status).toBe("cancelled")
    expect(reopenedPermissionRepository.requests.get(permissionEvent.requestId)).toMatchObject({
      id: permissionEvent.requestId,
      status: "cancelled",
    })
  })

  test("active permission runs stay isolated across different sqlite databases", async () => {
    const harnessA = await createHarness("permission-db-a", false, {
      sessionId: "session_same",
    })
    const harnessB = await createHarness("permission-db-b", false, {
      sessionId: "session_same",
    })
    const runtimeA = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_a",
            name: "write",
            inputText: '{"path":"a.txt","content":"from-a"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "A done." }
        },
      ]),
      harness: harnessA,
      permissionPolicy: {
        write: "ask",
      },
    })
    const runtimeB = createPermissionRuntime({
      provider: createTurnProvider([], [
        async function* () {
          yield {
            type: "tool.call",
            callId: "call_write_b",
            name: "write",
            inputText: '{"path":"b.txt","content":"from-b"}',
          }
        },
        async function* () {
          yield { type: "text.delta", text: "B done." }
        },
      ]),
      harness: harnessB,
      permissionPolicy: {
        write: "ask",
      },
    })

    const startedA = startPromptRun({
      repository: harnessA.repository,
      service: harnessA.service,
      sessionId: harnessA.session.id,
      runId: "run_same",
      messageId: "message_a_user",
      prompt: "Write a.txt",
    })
    const handleA = await runtimeA.run({
      sessionId: harnessA.session.id,
      runId: startedA.run.id,
    })
    const iteratorA = handleA.events[Symbol.asyncIterator]()
    const permissionA = await waitForPermissionRequest(iteratorA)

    const startedB = startPromptRun({
      repository: harnessB.repository,
      service: harnessB.service,
      sessionId: harnessB.session.id,
      runId: "run_same",
      messageId: "message_b_user",
      prompt: "Write b.txt",
    })
    const handleB = await runtimeB.run({
      sessionId: harnessB.session.id,
      runId: startedB.run.id,
    })
    const iteratorB = handleB.events[Symbol.asyncIterator]()
    const permissionB = await waitForPermissionRequest(iteratorB)

    runtimeB.cancelRun(startedB.run.id)
    const remainingEventsB = await collectEvents(iteratorB)

    expect(remainingEventsB.at(-1)).toMatchObject({
      type: "run.cancelled",
      runId: startedB.run.id,
    })
    expect(harnessB.repository.runs.get(startedB.run.id).status).toBe("cancelled")
    expect(harnessB.permissionRepository.requests.get(permissionB.requestId)).toMatchObject({
      id: permissionB.requestId,
      status: "cancelled",
    })

    expect(harnessA.repository.runs.get(startedA.run.id).status).toBe("waiting_permission")
    expect(harnessA.permissionRepository.requests.get(permissionA.requestId)).toMatchObject({
      id: permissionA.requestId,
      status: "pending",
    })

    runtimeA.respondPermission({
      requestId: permissionA.requestId,
      decision: "allow",
    })
    const remainingEventsA = await collectEvents(iteratorA)

    expect(remainingEventsA.at(-1)).toMatchObject({
      type: "run.completed",
      runId: startedA.run.id,
    })
    expect(await readFile(join(harnessA.workspaceRoot, "a.txt"), "utf8")).toBe("from-a")
    expect(await fileExists(join(harnessB.workspaceRoot, "b.txt"))).toBe(false)
  })

  test("replying to an unknown permission request fails explicitly", async () => {
    const harness = await createHarness("permission-missing", false)
    const runtime = createPermissionRuntime({
      provider: createTurnProvider([], []),
      harness,
    })

    expect(() =>
      runtime.respondPermission({
        requestId: "permission_missing",
        decision: "allow",
      }),
    ).toThrow(PermissionNotFoundError)
  })
})

async function createHarness(
  prefix: string,
  withFixtureWorkspace: boolean,
  options: {
    sessionId?: string
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  tempDirectories.push(directory)

  const workspaceRoot = join(directory, "workspace")
  if (withFixtureWorkspace) {
    await cp("test/fixtures/workspaces/read-search", workspaceRoot, { recursive: true })
  } else {
    await mkdir(workspaceRoot, { recursive: true })
    await Bun.write(join(workspaceRoot, "placeholder.txt"), "placeholder")
  }

  const now = createMonotonicClock()
  const database = trackDatabase(openStorageDatabase(join(directory, "agent.sqlite")))
  const repository = createStorageRepository({
    database,
    now,
  })
  const permissionRepository = createPermissionRepository({
    database,
    now,
  })
  const service = createSessionRunService({
    repository,
    now,
  })
  const session = repository.sessions.create({
    id: options.sessionId ?? `${prefix}_session`,
    directory: workspaceRoot,
    workspaceRoot,
    createdAt: now(),
  })

  return {
    repository,
    permissionRepository,
    service,
    session,
    workspaceRoot,
    databasePath: join(directory, "agent.sqlite"),
    now,
  }
}

function createPermissionRuntime(input: {
  provider: OrchestrationModelPort
  harness: Awaited<ReturnType<typeof createHarness>>
  permissionPolicy?: Partial<
    Record<
      "write" | "edit" | "shell" | "webfetch" | "websearch" | "codesearch" | "plan_exit",
      "allow" | "ask" | "deny"
    >
  >
}) {
  return createRuntime({
    provider: input.provider,
    repository: input.harness.repository,
    permissionRepository: input.harness.permissionRepository,
    now: input.harness.now,
    permissionPolicy: input.permissionPolicy,
  }) as RuntimeController
}

function startPromptRun(input: {
  repository: StorageRepository
  service: ReturnType<typeof createSessionRunService>
  sessionId: string
  runId: string
  messageId: string
  prompt: string
}) {
  const started = input.service.startRun({
    sessionId: input.sessionId,
    runId: input.runId,
    messageId: input.messageId,
  })

  input.repository.parts.create({
    sessionId: input.sessionId,
    runId: started.run.id,
    messageId: started.message.id,
    kind: "text",
    sequence: 0,
    text: input.prompt,
  })

  return started
}

function createTurnProvider(
  requests: ProviderTurnRequest[],
  turns: Array<(request: ProviderTurnRequest) => AsyncIterable<ProviderEvent>>,
){
  let index = 0

  return createModelProvider({
    runtime: createModelRuntimeApi({
      async *streamTurn(request: ProviderTurnRequest) {
        requests.push(request)
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

function readToolResultParts(request: ProviderTurnRequest) {
  return request.messages.flatMap((message) =>
    message.role !== "tool"
      ? []
      : message.parts.filter(
          (part): part is Extract<(typeof message.parts)[number], { type: "tool_result" }> =>
            part.type === "tool_result",
        ),
  )
}

async function waitForPermissionRequest(
  events: AsyncIterable<OrchestrationRuntimeEvent> | AsyncIterator<OrchestrationRuntimeEvent>,
): Promise<PermissionRequestedEvent> {
  const iterator = toAsyncIterator(events)

  while (true) {
    const next = await iterator.next()
    if (next.done) {
      break
    }

    const event = next.value
    if (event != null && typeof event === "object" && "type" in event && event.type === "permission.requested") {
      return event
    }
  }

  throw new Error("Expected permission.requested before the event stream closed")
}

async function waitForPermissionRequestWithin(
  events: AsyncIterable<OrchestrationRuntimeEvent> | AsyncIterator<OrchestrationRuntimeEvent>,
  timeoutMs: number,
): Promise<PermissionRequestedEvent> {
  return await Promise.race([
    waitForPermissionRequest(events),
    (async () => {
      await Bun.sleep(timeoutMs)
      throw new Error(`Expected permission.requested within ${timeoutMs}ms`)
    })(),
  ])
}

async function collectEvents(
  events: AsyncIterable<OrchestrationRuntimeEvent> | AsyncIterator<OrchestrationRuntimeEvent>,
) {
  const iterator = toAsyncIterator(events)
  const collected: OrchestrationRuntimeEvent[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      break
    }
    collected.push(next.value)
  }
  return collected
}

function toAsyncIterator(
  events: AsyncIterable<OrchestrationRuntimeEvent> | AsyncIterator<OrchestrationRuntimeEvent>,
): AsyncIterator<OrchestrationRuntimeEvent> {
  if ("next" in events) {
    return events
  }

  return events[Symbol.asyncIterator]()
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function createMonotonicClock(start = 1) {
  let current = start
  return () => {
    const value = current
    current += 1
    return value
  }
}

function trackDatabase<T extends { close: (throwOnError: boolean) => void }>(database: T) {
  openDatabases.push(database)
  return database
}
