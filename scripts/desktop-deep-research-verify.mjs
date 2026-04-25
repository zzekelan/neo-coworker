import { _electron as electron } from "playwright"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cwd = process.cwd()
const prompt =
  process.env.DESKTOP_DEEP_RESEARCH_VERIFY_PROMPT?.trim() ||
  "帮我搜索10条过去3个月内的英文AI前沿资讯并总结，只要英文来源，用中文汇报。请使用subagent完成这项任务。"
const timeoutMs = parsePositiveInt(process.env.DESKTOP_DEEP_RESEARCH_VERIFY_TIMEOUT_MS, 900_000)

const evidenceRoot = join(cwd, ".sisyphus", "evidence", "task-8-deep-research-real-path")
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
    name: "task-8-deep-research-real-path",
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
    prompt,
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
  assertReasonableFinalOutput(transcriptSummary.parent.finalAssistantText)

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
            ...event,
            data: parseJson(event.dataJson),
            dataJson: undefined,
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
    const toolCalls = db
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
      .map((part) => ({
        sessionId: part.sessionId,
        runId: part.runId,
        kind: part.kind,
        textPreview: preview(part.textValue),
        data: parseJson(part.dataJson),
      }))

    return {
      databasePath: input.databasePath,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      childSessions,
      runs,
      runEvents,
      messageCounts: messageRows,
      partCounts: partRows,
      toolCalls,
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
      session: child.session,
      ...summarizeTranscript(child.transcript),
    })),
  }
}

function summarizeTranscript(transcript) {
  const parts = transcript.flatMap((message) => message.parts ?? [])
  const visibleText = readTranscriptVisibleText(transcript)
  const assistantTexts = transcript
    .filter((message) => message.role === "assistant")
    .map((message) => readMessageText(message))
    .filter(Boolean)
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
    visibleTextPreview: preview(visibleText, 1_500),
    finalAssistantText: assistantTexts.at(-1) ?? "",
  }
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
    reason: data.reason ?? null,
    errorCode: data.errorCode ?? null,
    errorMessage: data.errorMessage ?? null,
  }
}

function assertSubagentUsage(input) {
  const lifecycleEvents = allLifecycleEvents(input.lifecycleSummary)
  const hasSourceResearcherStarted = lifecycleEvents.some(
    (event) => event.eventType === "subagent.started" && event.agentId === "source-researcher" && event.displayName === "Source Researcher" && event.parentRunId && event.subRunId,
  )
  const hasSourceResearcherCompleted = lifecycleEvents.some(
    (event) => event.eventType === "subagent.completed" && event.agentId === "source-researcher" && event.displayName === "Source Researcher" && event.parentRunId && event.subRunId,
  )
  assert(hasSourceResearcherStarted, "Deep Research lifecycle did not record source-researcher subagent.started.")
  assert(hasSourceResearcherCompleted, "Deep Research lifecycle did not record source-researcher subagent.completed.")

  assert(
    input.transcriptSummary.parent.toolNames.includes("agent") ||
      input.sqliteTelemetry.toolCalls.some((part) => readToolName(part) === "agent"),
    "Parent transcript/SQLite telemetry did not record an agent tool call.",
  )
  const optionalToolEventTypes = ["tool.call.requested", "tool.call.completed"]
  const hasToolRunEvent = optionalToolEventTypes.some((eventType) => input.sqliteTelemetry.eventTypes.includes(eventType))
  const hasDurableToolParts = input.sqliteTelemetry.toolCalls.some((part) => part.kind === "tool_call") &&
    input.sqliteTelemetry.toolCalls.some((part) => part.kind === "tool_result")
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
  const calledToolNames = new Set(input.sqliteTelemetry.toolCalls.map(readToolName).filter(Boolean))
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

function assertReasonableFinalOutput(finalText) {
  const compact = String(finalText ?? "").replace(/\s+/gu, "").trim()
  assert(compact.length >= 40, "Deep Research final output was not a reasonable final output.")
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

function hasTranscriptPart(transcript, kind, toolName) {
  return transcript.some((message) =>
    (message.parts ?? []).some(
      (part) => part.kind === kind && (part.data?.toolName ?? part.data?.name ?? null) === toolName,
    ),
  )
}

function readTranscriptVisibleText(transcript) {
  return transcript.map(readMessageText).filter(Boolean).join("\n")
}

function readMessageText(message) {
  return (message.parts ?? [])
    .flatMap((part) => {
      if ((part.kind === "text" || part.kind === "tool_result") && typeof part.text === "string") {
        return [part.text]
      }
      return []
    })
    .join("\n")
}

function readToolName(part) {
  return part.data?.toolName ?? part.data?.name ?? part.data?.tool ?? null
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
