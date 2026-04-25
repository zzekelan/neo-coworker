import { _electron as electron } from "playwright"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cwd = process.cwd()
const prompt =
  process.env.DESKTOP_DEEP_RESEARCH_VERIFY_PROMPT?.trim() ||
  "请验证 Deep Research 真实路径：必须调用 agent 工具启动至少一个 source-researcher subagent；要求该 subagent 先按 source-note 技能提示用 read 读取 source-note-schema.md 参考文件，再用 websearch 查找过去3个月内2条英文AI前沿资讯来源；随后必须调用 webfetch 获取这个大型公开原始文件 https://raw.githubusercontent.com/microsoft/TypeScript/main/src/compiler/checker.ts 以验证超大工具结果截断/落盘 telemetry；最后用中文给出简短总结，不要粘贴大型文件内容。"
const timeoutMs = parsePositiveInt(process.env.DESKTOP_DEEP_RESEARCH_VERIFY_TIMEOUT_MS, 900_000)
const SUMMARY_PREVIEW_LIMIT = 500
const SUBAGENT_RESULT_SIZE_LIMIT = 50_000
const WEBFETCH_TRUNCATED_RESULT_MAX = 55_000

const evidenceRoot = join(cwd, ".sisyphus", "evidence", "task-7-deep-research-real-path")
const tracePath = join(evidenceRoot, "trace.zip")
const screenshotPath = join(evidenceRoot, "screenshot.png")
const sessionSummaryPath = join(evidenceRoot, "session-summary.json")
const lifecycleSummaryPath = join(evidenceRoot, "lifecycle-summary.json")
const transcriptSummaryPath = join(evidenceRoot, "transcript-summary.json")
const sqliteTelemetrySummaryPath = join(evidenceRoot, "sqlite-telemetry-summary.json")
const bootstrapLogPath = join(evidenceRoot, "desktop-bootstrap.log")

mkdirSync(evidenceRoot, { recursive: true })

const isolatedRoot = mkdtempSync(join(tmpdir(), "neo-coworker-deep-research-"))
const workspaceRoot = join(isolatedRoot, "workspace")
const databasePath = join(isolatedRoot, "server.sqlite")
mkdirSync(workspaceRoot, { recursive: true })

const launchEnv = {
  ...process.env,
  DESKTOP_WORKSPACE_ROOT: workspaceRoot,
  DESKTOP_SELECTION_STATE_PATH: join(isolatedRoot, "desktop-state.json"),
  DESKTOP_SETTINGS_STATE_PATH: join(isolatedRoot, "desktop-settings.json"),
  NCOWORKER_SERVER_DB_PATH: databasePath,
  DESKTOP_BOOTSTRAP_LOG: bootstrapLogPath,
}
delete launchEnv.NCOWORKER_SERVER_URL
delete launchEnv.AGENT_SERVER_URL

let app = null
let traceStarted = false

try {
  app = await electron.launch({
    args: ["src/desktop/electron/main.mjs"],
    cwd,
    env: launchEnv,
  })
  const page = await app.firstWindow()

  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => document.body.innerText.includes("NeoCoworker"), null, {
    timeout: 30_000,
  })
  await page.waitForFunction(() => Boolean(window.neoCoworkerDesktop?.requestJson), null, {
    timeout: 30_000,
  })

  const bridgeWorkspaceRoot = await page.evaluate(
    () =>
      window.neoCoworkerDesktop.persistedWorkspaceRoot ??
      window.neoCoworkerDesktop.defaultWorkspaceRoot ??
      null,
  )
  assert(
    bridgeWorkspaceRoot === workspaceRoot,
    `Desktop bridge did not expose the isolated workspace root (got ${bridgeWorkspaceRoot ?? "null"}).`,
  )

  const settingsSnapshot = await page.evaluate(async () => {
    const snapshot = await window.neoCoworkerDesktop.loadDesktopSettings?.()
    const settings = snapshot?.settings ?? null
    return {
      serverMode: snapshot?.serverMode ?? null,
      provider: settings?.provider ?? null,
      model: settings?.model ?? null,
      baseURL: settings?.baseURL ?? null,
      apiKeyConfigured: typeof settings?.apiKey === "string" && settings.apiKey.length > 0,
    }
  })
  assert(settingsSnapshot.serverMode === "managed-local", "Deep Research verifier must use managed-local desktop/server state.")
  assert(settingsSnapshot.provider, "Desktop Deep Research verifier needs a real LLM provider in settings/.env.")
  assert(settingsSnapshot.model, "Desktop Deep Research verifier needs a real LLM model in settings/.env.")
  assert(settingsSnapshot.apiKeyConfigured, "Desktop Deep Research verifier needs a real LLM API key in settings/.env.")

  await page.context().tracing.start({
    name: "task-7-deep-research-real-path",
    screenshots: true,
    snapshots: true,
    sources: false,
  })
  traceStarted = true

  function requestJson(path, method = "GET", body) {
    return page.evaluate(
      async ({ path: nextPath, method: nextMethod, body: nextBody }) => {
        return await window.neoCoworkerDesktop.requestJson({
          path: nextPath,
          method: nextMethod,
          body: nextBody,
        })
      },
      { path, method, body },
    )
  }

  const primaryAgentsResponse = await requestJson(`/agents/primary?workspaceRoot=${encodeURIComponent(workspaceRoot)}`)
  const primaryAgents = unwrapData(primaryAgentsResponse, "load /agents/primary").agents
  assertPrimaryAgentDisplayNames(primaryAgents)

  const sessionsPath = `/workspace/sessions?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
  const beforeSessions = unwrapData(await requestJson(sessionsPath), "list workspace sessions before create").sessions ?? []
  const beforeIds = new Set(beforeSessions.map((session) => session.id))

  await page.getByTitle("New Session").click()
  const parentSessionId = await waitForCreatedSession({ requestJson, sessionsPath, beforeIds, page })
  assert(parentSessionId, "Desktop UI did not create a new Deep Research parent session.")

  await page.locator('[data-testid="agent-badge"]').click()
  await page.locator('[data-testid="agent-option-deep-research"]').click()

  await page.waitForFunction(
    () => document.querySelector('[data-testid="agent-badge"]')?.textContent?.includes("Deep Research"),
    null,
    { timeout: 10_000 },
  )
  await waitForSessionAgent({ requestJson, sessionId: parentSessionId, expectedAgent: "deep-research", page })

  await page.locator("textarea").fill(prompt)
  await page.locator("button[type=submit]").click()

  const runResult = await waitForRunCompletion({
    page,
    requestJson,
    sessionId: parentSessionId,
    timeoutMs,
  })
  assert(
    runResult.latestRunStatus === "completed",
    `Deep Research desktop run did not complete successfully (status=${runResult.latestRunStatus ?? "missing"}).`,
  )
  assert(runResult.latestRunId, "Completed Deep Research run did not expose a run id.")

  const parentTranscript = unwrapTranscript(
    await requestJson(`/sessions/${encodeURIComponent(parentSessionId)}/transcript`),
    "fetch parent transcript",
  )
  const parentSessionSnapshot = unwrapData(
    await requestJson(`/sessions/${encodeURIComponent(parentSessionId)}`),
    "fetch parent session",
  )
  const parentRunTrace = unwrapData(
    await requestJson(`/runs/${encodeURIComponent(runResult.latestRunId)}/trace`),
    "fetch parent run trace",
  ).trace

  const sqliteTelemetry = readSqliteTelemetrySummary({
    databasePath,
    workspaceRoot,
    parentSessionId,
    parentRunId: runResult.latestRunId,
  })
  assert(sqliteTelemetry.childSessions.length > 0, "Real Deep Research path did not create a child SubSession.")

  const childTranscripts = []
  for (const child of sqliteTelemetry.childSessions) {
    childTranscripts.push({
      session: child,
      transcript: unwrapTranscript(
        await requestJson(`/sessions/${encodeURIComponent(child.id)}/transcript`),
        `fetch child transcript ${child.id}`,
      ),
    })
  }

  const lifecycleSummary = buildLifecycleSummary({
    trace: parentRunTrace,
    sqliteTelemetry,
  })
  const transcriptSummary = buildTranscriptSummary({
    parentTranscript,
    childTranscripts,
  })
  const sessionSummary = {
    workspaceRoot,
    databasePath,
    promptLength: prompt.length,
    provider: settingsSnapshot.provider,
    model: settingsSnapshot.model,
    baseURLConfigured: Boolean(settingsSnapshot.baseURL),
    apiKeyConfigured: settingsSnapshot.apiKeyConfigured,
    parentSessionId,
    parentRunId: runResult.latestRunId,
    latestRunStatus: runResult.latestRunStatus,
    currentAgent: parentSessionSnapshot.session?.currentAgent ?? null,
    primaryAgents,
    childSessionIds: sqliteTelemetry.childSessions.map((session) => session.id),
    permissionsApproved: runResult.permissionsApproved,
  }

  assertSubagentUsage({ lifecycleSummary, transcriptSummary, sqliteTelemetry })
  assertSourceNoteSkillLoadSucceeded({ lifecycleSummary, sqliteTelemetry })
  assertNoWorkspaceSkillFallback({ workspaceRoot, lifecycleSummary, transcriptSummary, sqliteTelemetry })
  assertNoResearchSourceNoteEnoent({ lifecycleSummary, transcriptSummary, sqliteTelemetry })
  assertNoUnknownWebsearchError({ lifecycleSummary, transcriptSummary, sqliteTelemetry })
  assertSourceResearcherWebsearchAvailable({ transcriptSummary, sqliteTelemetry })
  assertBuiltinReferenceReadPaths({ sqliteTelemetry })
  assertToolResultStorageAndTelemetry({ workspaceRoot, sqliteTelemetry })
  assertReasonableFinalOutput(transcriptSummary.parent.finalAssistantLength)

  await page.screenshot({ path: screenshotPath, fullPage: true })
  if (traceStarted) {
    await page.context().tracing.stop({ path: tracePath })
    traceStarted = false
  }

  writeFileSync(sessionSummaryPath, `${JSON.stringify(sessionSummary, null, 2)}\n`)
  writeFileSync(lifecycleSummaryPath, `${JSON.stringify(lifecycleSummary, null, 2)}\n`)
  writeFileSync(transcriptSummaryPath, `${JSON.stringify(transcriptSummary, null, 2)}\n`)
  writeFileSync(sqliteTelemetrySummaryPath, `${JSON.stringify(sqliteTelemetry, null, 2)}\n`)

  console.log(
    JSON.stringify(
      {
        ok: true,
        parentSessionId,
        parentRunId: runResult.latestRunId,
        childSessionIds: sessionSummary.childSessionIds,
        latestRunStatus: runResult.latestRunStatus,
        evidence: {
          tracePath,
          screenshotPath,
          sessionSummaryPath,
          lifecycleSummaryPath,
          transcriptSummaryPath,
          sqliteTelemetrySummaryPath,
        },
      },
      null,
      2,
    ),
  )
} finally {
  if (traceStarted && app) {
    try {
      const page = await app.firstWindow()
      await page.context().tracing.stop({ path: tracePath })
    } catch {
      // Best-effort trace capture on failure.
    }
  }
  if (app) {
    await app.close().catch(() => undefined)
  }
  rmSync(isolatedRoot, { recursive: true, force: true })
}

async function waitForCreatedSession(input) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const sessions = unwrapData(await input.requestJson(input.sessionsPath), "poll workspace sessions after create").sessions ?? []
    const created = sessions.find((session) => input.beforeIds.has(session.id) === false) ?? null
    if (created) {
      return created.id
    }
    await input.page.waitForTimeout(250)
  }
  return null
}

async function waitForSessionAgent(input) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = unwrapData(await input.requestJson(`/sessions/${encodeURIComponent(input.sessionId)}`), "poll session agent")
    if (snapshot.session?.currentAgent === input.expectedAgent) {
      return
    }
    await input.page.waitForTimeout(250)
  }
  throw new Error(`Session did not persist selected agent ${input.expectedAgent}.`)
}

async function waitForRunCompletion(input) {
  const startedAt = Date.now()
  let latestRunStatus = null
  let latestRunId = null
  let permissionsApproved = 0

  while (Date.now() - startedAt < input.timeoutMs) {
    const sessionResponse = await input.requestJson(`/sessions/${encodeURIComponent(input.sessionId)}`)
    const snapshot = sessionResponse.body?.data ?? null
    latestRunStatus = snapshot?.latestRun?.status ?? latestRunStatus
    latestRunId = snapshot?.latestRun?.id ?? latestRunId

    if (latestRunId) {
      permissionsApproved += await approvePendingPermissions({
        page: input.page,
        requestJson: input.requestJson,
        runId: latestRunId,
      })
    }

    if (latestRunStatus === "completed" || latestRunStatus === "failed" || latestRunStatus === "cancelled") {
      return { latestRunStatus, latestRunId, permissionsApproved }
    }

    await input.page.waitForTimeout(1_000)
  }

  throw new Error(`Timed out waiting for Deep Research run after ${input.timeoutMs}ms (status=${latestRunStatus ?? "missing"}).`)
}

async function approvePendingPermissions(input) {
  const runResponse = await input.requestJson(`/runs/${encodeURIComponent(input.runId)}`)
  const permissionRequests = runResponse.body?.data?.permissionRequests ?? []
  let approved = 0

  for (const request of permissionRequests) {
    if (request.status !== "pending") {
      continue
    }

    if (!(await clickVisibleAllowButton(input.page))) {
      const reply = await input.requestJson(
        `/permissions/${encodeURIComponent(request.id)}/reply`,
        "POST",
        { decision: "allow" },
      )
      assert(reply.ok, `Failed to approve permission request ${request.id}.`)
    }
    approved += 1
    await input.page.waitForTimeout(250)
  }

  return approved
}

async function clickVisibleAllowButton(page) {
  const allowButtons = page.getByRole("button", { name: /^Allow$|^允许$/ })
  const count = await allowButtons.count()
  for (let index = 0; index < count; index += 1) {
    const button = allowButtons.nth(index)
    if ((await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))) {
      await button.click({ timeout: 5_000 })
      return true
    }
  }
  return false
}

function assertPrimaryAgentDisplayNames(agents) {
  const simplified = agents.map((agent) => ({ name: agent.name, displayName: agent.displayName }))
  const expected = [
    { name: "general", displayName: "General" },
    { name: "plan", displayName: "Plan" },
    { name: "deep-research", displayName: "Deep Research" },
  ]
  assert(JSON.stringify(simplified) === JSON.stringify(expected), `/agents/primary returned unexpected display names: ${JSON.stringify(simplified)}`)
  assert(agents.some((agent) => agent.name === "source-researcher") === false, "/agents/primary exposed hidden source-researcher.")
  assert(agents.some((agent) => agent.displayName === "Source Researcher") === false, "/agents/primary exposed hidden Source Researcher label.")
}

function readSqliteTelemetrySummary(input) {
  const db = new DatabaseSync(input.databasePath)
  try {
    db.exec("PRAGMA query_only = ON")
    const childSessions = db
      .prepare(
        `
          SELECT id, title, current_agent AS currentAgent, parent_session_id AS parentSessionId, created_at AS createdAt, updated_at AS updatedAt
          FROM session
          WHERE parent_session_id = ?
          ORDER BY created_at ASC
        `,
      )
      .all(input.parentSessionId)

    const sessionIds = [input.parentSessionId, ...childSessions.map((session) => session.id)]
    const runs = db
      .prepare(
        `
          SELECT id, session_id AS sessionId, parent_run_id AS parentRunId, status, error_text AS errorText, input_tokens AS inputTokens, output_tokens AS outputTokens, token_usage_source AS tokenUsageSource
          FROM run
          WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
          ORDER BY created_at ASC
        `,
      )
      .all(...sessionIds)
    const runIds = runs.map((run) => run.id)
    const runEvents = runIds.length === 0
      ? []
      : db
          .prepare(
            `
              SELECT session_id AS sessionId, run_id AS runId, sequence, source, event_type AS eventType, data_json AS dataJson, created_at AS createdAt
              FROM run_event
              WHERE run_id IN (${runIds.map(() => "?").join(",")})
              ORDER BY run_id ASC, sequence ASC
            `,
          )
          .all(...runIds)
          .map((event) => ({
            sessionId: event.sessionId,
            runId: event.runId,
            sequence: event.sequence,
            source: event.source,
            eventType: event.eventType,
            data: summarizeEventData(parseJson(event.dataJson), {
              eventType: event.eventType,
              sessionId: event.sessionId,
              runId: event.runId,
            }),
            createdAt: event.createdAt,
          }))
    const messageRows = db
      .prepare(
        `
          SELECT session_id AS sessionId, run_id AS runId, role, COUNT(*) AS count
          FROM message
          WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
          GROUP BY session_id, run_id, role
          ORDER BY session_id ASC, run_id ASC, role ASC
        `,
      )
      .all(...sessionIds)
    const partRows = db
      .prepare(
        `
          SELECT session_id AS sessionId, run_id AS runId, kind, COUNT(*) AS count
          FROM part
          WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
          GROUP BY session_id, run_id, kind
          ORDER BY session_id ASC, run_id ASC, kind ASC
        `,
      )
      .all(...sessionIds)
    const toolParts = db
      .prepare(
        `
          SELECT session_id AS sessionId, run_id AS runId, kind, text_value AS textValue, data_json AS dataJson
          FROM part
          WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
            AND kind IN ('tool_call', 'tool_result')
          ORDER BY created_at ASC, sequence ASC
        `,
      )
      .all(...sessionIds)
      .map(summarizeToolPart)
    const toolCalls = toolParts.filter((part) => part.kind === "tool_call")
    const toolResults = toolParts.filter((part) => part.kind === "tool_result")

    return {
      databasePath: input.databasePath,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      childSessions: childSessions.map(summarizeSessionRecord),
      runs,
      runEvents,
      messageCounts: messageRows,
      partCounts: partRows,
      toolCalls,
      toolResults,
      eventTypes: runEvents.map((event) => event.eventType),
    }
  } finally {
    db.close()
  }
}

function buildLifecycleSummary(input) {
  const traceEvents = Array.isArray(input.trace?.events) ? input.trace.events : []
  const traceLifecycleEvents = traceEvents.filter((event) => isLifecycleEventType(event.eventType))
  const sqliteLifecycleEvents = input.sqliteTelemetry.runEvents.filter((event) => isLifecycleEventType(event.eventType))
  return {
    traceEventTypes: traceEvents.map((event) => event.eventType),
    traceLifecycleEvents: traceLifecycleEvents.map(summarizeLifecycleEvent),
    sqliteLifecycleEvents: sqliteLifecycleEvents.map(summarizeLifecycleEvent),
  }
}

function buildTranscriptSummary(input) {
  return {
    parent: summarizeTranscript(input.parentTranscript),
    children: input.childTranscripts.map((child) => ({
      session: summarizeSessionRecord(child.session),
      ...summarizeTranscript(child.transcript),
    })),
  }
}

function summarizeSessionRecord(session) {
  return {
    id: session.id,
    titleLength: typeof session.title === "string" ? session.title.length : 0,
    currentAgent: session.currentAgent ?? null,
    parentSessionId: session.parentSessionId ?? null,
    createdAt: session.createdAt ?? null,
    updatedAt: session.updatedAt ?? null,
  }
}

function summarizeTranscript(transcript) {
  const parts = transcript.flatMap((message) => message.parts ?? [])
  const visibleText = readTranscriptVisibleText(transcript)
  const assistantTexts = transcript
    .filter((message) => message.role === "assistant")
    .map((message) => readMessageText(message, { includeToolResults: false }))
    .filter(Boolean)
  const finalText = assistantTexts.at(-1) ?? ""
  return {
    messageCount: transcript.length,
    partKinds: countBy(parts.map((part) => part.kind)),
    toolNames: parts
      .filter((part) => part.kind === "tool_call" || part.kind === "tool_result")
      .map((part) => part.data?.toolName ?? part.data?.name ?? null)
      .filter(Boolean),
    lifecycleEvents: parts
      .filter((part) => part.kind === "lifecycle")
      .map((part) => summarizeLifecycleEvent({ eventType: part.data?.type, data: part.data })),
    visibleTextLength: visibleText.length,
    finalAssistantLength: finalText.length,
    finalAssistantPreview: preview(finalText),
  }
}

function summarizeEventData(data, context) {
  if (!data || typeof data !== "object") {
    return data
  }

  const sanitized = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === "output" && typeof value === "string") {
      sanitized.outputLength = value.length
      sanitized.outputPreview = preview(value)
      continue
    }
    if (key === "inputText" && typeof value === "string") {
      sanitized.inputLength = value.length
      appendSafeToolInputFields({ target: sanitized, inputText: value })
      continue
    }
    if (key === "prompt" && typeof value === "string") {
      sanitized.promptLength = value.length
      continue
    }
    if (key === "fullPromptText" && typeof value === "string") {
      sanitized.fullPromptLength = value.length
      continue
    }
    if (key === "metadata") {
      sanitized.metadata = sanitizeMetadata(value)
      continue
    }
    appendSanitizedNestedSummaryValue({ target: sanitized, key, value })
  }

  sanitized.sessionId ??= context.sessionId
  sanitized.runId ??= context.runId
  sanitized.eventType ??= context.eventType
  return sanitized
}

function summarizeToolPart(part) {
  const data = parseJson(part.dataJson)
  const toolName = readToolName({ data })
  if (part.kind === "tool_result") {
    const output = readToolResultOutput({ textValue: part.textValue, data })
    return {
      sessionId: part.sessionId,
      runId: part.runId,
      kind: part.kind,
      toolName,
      outputLength: output.length,
      outputPreview: preview(output),
      metadata: sanitizeMetadata(data?.metadata),
    }
  }

  return {
    sessionId: part.sessionId,
    runId: part.runId,
    kind: part.kind,
    toolName,
    inputLength: typeof part.textValue === "string" ? part.textValue.length : 0,
    path: readToolCallPath(data),
  }
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== "object") {
    return {}
  }

  const allowedKeys = new Set([
    "truncated",
    "originalSize",
    "truncatedSize",
    "resultSizeLimit",
    "savedPath",
    "isCompressible",
  ])
  const sanitized = {}
  for (const [key, item] of Object.entries(value)) {
    if (allowedKeys.has(key)) {
      sanitized[key] = item
    }
  }
  return sanitized
}

function appendSanitizedNestedSummaryValue(input) {
  if (isSensitiveTextKey(input.key) && typeof input.value === "string") {
    input.target[lengthKeyForSensitiveText(input.key)] = input.value.length
    return
  }
  input.target[input.key] = sanitizeNestedSummaryValue(input.value)
}

function sanitizeNestedSummaryValue(value) {
  if (typeof value === "string") {
    return value.length > SUMMARY_PREVIEW_LIMIT ? preview(value) : value
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeNestedSummaryValue)
  }
  if (!value || typeof value !== "object") {
    return value
  }
  const sanitized = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveTextKey(key) && typeof item === "string") {
      sanitized[lengthKeyForSensitiveText(key)] = item.length
      continue
    }
    if (key === "output" && typeof item === "string") {
      sanitized.outputLength = item.length
      sanitized.outputPreview = preview(item)
      continue
    }
    sanitized[key] = sanitizeNestedSummaryValue(item)
  }
  return sanitized
}

function appendSafeToolInputFields(input) {
  const parsed = parseJson(input.inputText)
  const path = readToolCallPath({ inputText: input.inputText })
  if (typeof path === "string") {
    input.target.path = path
  }
  if (parsed && typeof parsed === "object" && typeof parsed.url === "string" && typeof parsed.prompt !== "string") {
    input.target.urlLength = parsed.url.length
  }
  if (parsed && typeof parsed === "object" && typeof parsed.query === "string" && typeof parsed.prompt !== "string") {
    input.target.queryLength = parsed.query.length
  }
}

function isSensitiveTextKey(key) {
  return key === "inputText" || key === "prompt" || key === "fullPromptText"
}

function lengthKeyForSensitiveText(key) {
  if (key === "inputText") {
    return "inputLength"
  }
  if (key === "fullPromptText") {
    return "fullPromptLength"
  }
  return "promptLength"
}

function summarizeLifecycleEvent(event) {
  const data = event.data ?? {}
  return {
    eventType: event.eventType,
    status: data.status ?? null,
    agentId: data.agentId ?? null,
    displayName: data.displayName ?? null,
    skillName: data.skillName ?? null,
    parentRunId: data.parentRunId ?? null,
    subRunId: data.subRunId ?? null,
    maxTurns: data.maxTurns ?? null,
    reason: data.reason ?? null,
    errorCode: data.errorCode ?? null,
    errorMessage: data.errorMessage ?? null,
    skillPath: data.skillPath ?? null,
  }
}

function assertSubagentUsage(input) {
  const lifecycleEvents = allLifecycleEvents(input.lifecycleSummary)
  const hasSourceResearcherStarted = lifecycleEvents.some(
    (event) => event.eventType === "subagent.started" && event.agentId === "source-researcher" && event.displayName === "Source Researcher" && event.parentRunId && event.subRunId,
  )
  const invalidMaxTurns = lifecycleEvents.some(
    (event) => event.eventType === "subagent.started" && event.agentId === "source-researcher" && event.maxTurns != null && (!Number.isInteger(event.maxTurns) || event.maxTurns <= 0),
  )
  const hasSourceResearcherCompleted = lifecycleEvents.some(
    (event) => event.eventType === "subagent.completed" && event.agentId === "source-researcher" && event.displayName === "Source Researcher" && event.parentRunId && event.subRunId,
  )
  assert(hasSourceResearcherStarted, "Deep Research lifecycle did not record source-researcher subagent.started.")
  assert(invalidMaxTurns === false, "Deep Research lifecycle recorded invalid source-researcher maxTurns telemetry.")
  assert(hasSourceResearcherCompleted, "Deep Research lifecycle did not record source-researcher subagent.completed.")

  assert(
    input.transcriptSummary.parent.toolNames.includes("agent") ||
      input.sqliteTelemetry.toolCalls.some((part) => readToolName(part) === "agent"),
    "Parent transcript/SQLite telemetry did not record an agent tool call.",
  )
  const optionalToolEventTypes = ["tool.call.requested", "tool.call.completed"]
  const hasToolRunEvent = optionalToolEventTypes.some((eventType) => input.sqliteTelemetry.eventTypes.includes(eventType))
  const hasDurableToolParts = input.sqliteTelemetry.toolCalls.length > 0 && input.sqliteTelemetry.toolResults.length > 0
  assert(
    hasToolRunEvent || hasDurableToolParts,
    "SQLite telemetry did not include durable tool-call evidence for the Deep Research path.",
  )
  assert(input.sqliteTelemetry.childSessions.length > 0, "SQLite session table did not record a child session.")
}

function assertSourceNoteSkillLoadSucceeded(input) {
  const lifecycleEvents = allLifecycleEvents(input.lifecycleSummary)
  const completed = lifecycleEvents.some(
    (event) =>
      event.eventType === "skill.load.completed" &&
      event.skillName === "source-note" &&
      event.reason,
  )
  assert(completed, "Source Researcher did not successfully load canonical source-note skill.")
  assert(
    lifecycleEvents.some((event) => event.eventType === "subagent.started" && event.agentId === "source-researcher" && event.displayName === "Source Researcher"),
    "Source Researcher identity lifecycle was not present alongside source-note load evidence.",
  )
  assert(
    lifecycleEvents.some((event) => event.eventType === "skill.load.failed" && event.skillName === "source-note") === false,
    "source-note skill load failed during Deep Research verifier.",
  )
}

function assertNoWorkspaceSkillFallback(input) {
  const fallbackPath = join(input.workspaceRoot, ".ncoworker", "skills", "research", "source-note", "SKILL.md")
  assert(existsSync(fallbackPath) === false, `Workspace source-note fallback was created: ${fallbackPath}`)
  const skillsRoot = join(input.workspaceRoot, ".ncoworker", "skills")
  assert(countFiles(skillsRoot) === 0, "Verifier found workspace skill creation under .ncoworker/skills/**.")
  const forbiddenSkillOperations = [
    "create_skill",
    "patch_skill",
    "delete_skill",
  ]
  const calledToolNames = new Set([
    ...input.sqliteTelemetry.toolCalls.map(readToolName),
    ...input.sqliteTelemetry.toolResults.map(readToolName),
  ].filter(Boolean))
  for (const operation of forbiddenSkillOperations) {
    assert(calledToolNames.has(operation) === false, `Telemetry recorded forbidden workspace skill operation ${operation}.`)
  }
}

function assertNoResearchSourceNoteEnoent(input) {
  const serialized = JSON.stringify(input)
  assert(/research\/source-note[^\n]{0,240}ENOENT|ENOENT[^\n]{0,240}research\/source-note/u.test(serialized) === false, "Found research/source-note ENOENT fallback signature.")
  assert(/\.ncoworker\/skills\/research\/source-note\/SKILL\.md[^\n]{0,240}ENOENT|ENOENT[^\n]{0,240}\.ncoworker\/skills\/research\/source-note\/SKILL\.md/u.test(serialized) === false, "Found workspace source-note ENOENT fallback signature.")
  assert(/\.ncoworker\/skills\/research\/deep-research\/references\/[^\n]{0,120}\.md[^\n]{0,240}ENOENT|ENOENT[^\n]{0,240}\.ncoworker\/skills\/research\/deep-research\/references\/[^\n]{0,120}\.md/u.test(serialized) === false, "Found workspace deep-research reference ENOENT signature for .ncoworker/skills/research/deep-research/references/*.md.")
  assert(/references\/source-note-schema\.md[^\n]{0,240}ENOENT|ENOENT[^\n]{0,240}references\/source-note-schema\.md/u.test(serialized) === false, "Found reference ENOENT signature for references/source-note-schema.md.")
  assert(serialized.includes("webfetch builtin:research/source-note/SKILL.md") === false, "Found forbidden webfetch builtin:research/source-note/SKILL.md guidance.")
}

function assertNoUnknownWebsearchError(input) {
  const serialized = JSON.stringify(input)
  assert(serialized.includes("Unknown tool: websearch") === false, "Found Unknown tool: websearch lifecycle/run error signature.")
}

function assertSourceResearcherWebsearchAvailable(input) {
  const childSessionIds = new Set(input.sqliteTelemetry.childSessions.map((session) => session.id))
  const hasChildWebsearchToolCall = input.sqliteTelemetry.toolCalls.some(
    (part) => childSessionIds.has(part.sessionId) && part.toolName === "websearch",
  )
  const hasTranscriptWebsearch = input.transcriptSummary.children.some((child) => child.toolNames.includes("websearch"))
  assert(
    hasChildWebsearchToolCall || hasTranscriptWebsearch,
    "Source Researcher did not exercise websearch through the real Deep Research path.",
  )
}

function assertBuiltinReferenceReadPaths(input) {
  const readPaths = input.sqliteTelemetry.toolCalls
    .filter((part) => part.toolName === "read" && typeof part.path === "string")
    .map((part) => part.path)
  assert(
    readPaths.some((path) => path.includes("/builtin-skills/") && path.endsWith("/references/source-note-schema.md")),
    "Verifier did not observe an absolute builtin-skills read path for references/source-note-schema.md.",
  )
  assert(
    readPaths.some((path) => path.includes("/.ncoworker/skills/research/deep-research/references/")) === false,
    "Verifier observed an old workspace deep-research reference read path.",
  )
}

function assertToolResultStorageAndTelemetry(input) {
  const childSessionIds = new Set(input.sqliteTelemetry.childSessions.map((session) => session.id))
  const sourceResearcherChildSessionIds = new Set(
    input.sqliteTelemetry.runEvents
      .filter((event) => event.eventType === "subagent.started" && event.data?.agentId === "source-researcher" && childSessionIds.has(event.sessionId))
      .map((event) => event.sessionId),
  )
  assert(sourceResearcherChildSessionIds.size > 0, "SQLite telemetry did not identify a source-researcher child session.")
  const sourceResearcherChildRunIds = new Set(input.sqliteTelemetry.runs.filter((run) => sourceResearcherChildSessionIds.has(run.sessionId)).map((run) => run.id))
  const childToolResults = input.sqliteTelemetry.toolResults.filter((part) => sourceResearcherChildSessionIds.has(part.sessionId))
  assert(childToolResults.length > 0, "SQLite telemetry did not include child/source-researcher tool results.")

  const managedChildResults = []
  for (const result of childToolResults) {
    assert(
      typeof result.outputPreview !== "string" || result.outputPreview.length <= SUMMARY_PREVIEW_LIMIT + 1,
      `Sanitized ${result.toolName ?? "tool"} result preview exceeded ${SUMMARY_PREVIEW_LIMIT} characters.`,
    )

    if (result.toolName === "webfetch") {
      assert(
        result.outputLength <= WEBFETCH_TRUNCATED_RESULT_MAX,
        `Child webfetch result retained ${result.outputLength} characters after truncation allowance.`,
      )
    }

    if (result.outputLength > SUBAGENT_RESULT_SIZE_LIMIT) {
      assert(
        result.metadata?.truncated === true && typeof result.metadata?.savedPath === "string",
        `Oversized ${result.toolName ?? "tool"} result lacked truncation metadata and savedPath.`,
      )
    }

    if (typeof result.metadata?.savedPath === "string") {
      managedChildResults.push(result)
      const expectedPrefix = `.ncoworker/tool-results/${result.sessionId}/${result.toolName}/`
      assert(
        result.metadata.savedPath.startsWith(expectedPrefix),
        `Saved result path ${result.metadata.savedPath} did not use session-scoped ${expectedPrefix} layout.`,
      )
      assert(existsSync(join(input.workspaceRoot, result.metadata.savedPath)), `Saved result path did not exist before cleanup: ${result.metadata.savedPath}`)
      assert(
        existsSync(join(input.workspaceRoot, ".ncoworker", "tool-results", result.toolName)) === false,
        `Old tool-scoped result directory was created for ${result.toolName}.`,
      )
    }
  }

  assert(managedChildResults.length > 0, "Real Task 7 path did not record any managed child/source-researcher tool result with metadata.savedPath.")
  assert(
    managedChildResults.some(
      (result) =>
        result.metadata?.truncated === true &&
        Number.isFinite(result.metadata?.originalSize) &&
        result.metadata.originalSize > SUBAGENT_RESULT_SIZE_LIMIT &&
        Number.isFinite(result.metadata?.truncatedSize) &&
        result.metadata.truncatedSize <= SUBAGENT_RESULT_SIZE_LIMIT &&
        result.metadata.resultSizeLimit === SUBAGENT_RESULT_SIZE_LIMIT,
    ),
    "Managed child tool result did not include expected 50KB truncation metadata.",
  )

  const managedBudgetEvents = input.sqliteTelemetry.runEvents.filter(
    (event) =>
      sourceResearcherChildRunIds.has(event.runId) &&
      (event.eventType === "budget.result_truncated" || event.eventType === "budget.spill_largest"),
  )
  assert(managedBudgetEvents.length > 0, "Real Task 7 path did not record child budget.result_truncated or budget.spill_largest telemetry.")
}

function assertReasonableFinalOutput(finalLength) {
  assert(Number.isFinite(finalLength) && finalLength >= 40, "Deep Research final output was not a reasonable final output.")
}

function allLifecycleEvents(summary) {
  return [...summary.traceLifecycleEvents, ...summary.sqliteLifecycleEvents]
}

function isLifecycleEventType(eventType) {
  return eventType === "subagent.started" ||
    eventType === "subagent.completed" ||
    eventType === "subagent.failed" ||
    eventType === "skill.load.requested" ||
    eventType === "skill.load.completed" ||
    eventType === "skill.load.failed"
}

function unwrapData(response, label) {
  assert(response?.ok, `${label} failed with status ${response?.status ?? "unknown"}: ${JSON.stringify(response?.body ?? null)}`)
  assert(response.body?.data, `${label} returned no data envelope.`)
  return response.body.data
}

function unwrapTranscript(response, label) {
  const data = unwrapData(response, label)
  assert(Array.isArray(data.transcript), `${label} did not return a transcript array.`)
  return data.transcript
}

function readTranscriptVisibleText(transcript) {
  return transcript.map(readMessageText).filter(Boolean).join("\n")
}

function readMessageText(message, options = { includeToolResults: true }) {
  return (message.parts ?? [])
    .flatMap((part) => {
      if (part.kind === "text" && typeof part.text === "string") {
        return [part.text]
      }
      if (options.includeToolResults && part.kind === "tool_result" && typeof part.text === "string") {
        return [part.text]
      }
      return []
    })
    .join("\n")
}

function readToolResultOutput(input) {
  if (typeof input.textValue === "string") {
    return input.textValue
  }
  if (input.data && typeof input.data === "object" && typeof input.data.output === "string") {
    return input.data.output
  }
  return ""
}

function readToolCallPath(data) {
  if (!data || typeof data !== "object") {
    return null
  }
  let args = null
  if (typeof data.inputText === "string") {
    args = parseJson(data.inputText)
  }
  if (!args || typeof args !== "object") {
    return null
  }
  return typeof args.path === "string" ? args.path : null
}

function readToolName(part) {
  return part.toolName ?? part.data?.toolName ?? part.data?.name ?? part.data?.tool ?? null
}

function countBy(values) {
  const counts = {}
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function parseJson(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

function preview(value, limit = 500) {
  if (typeof value !== "string") {
    return null
  }
  const compact = value.replace(/\s+/gu, " ").trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

function countFiles(path) {
  if (!existsSync(path)) {
    return 0
  }
  let count = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(path, entry.name)) : 1
  }
  return count
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
