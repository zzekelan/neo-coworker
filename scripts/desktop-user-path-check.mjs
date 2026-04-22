import { _electron as electron } from "playwright"
import { spawnSync } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cwd = process.cwd()
const isKimiMode = (process.env.DESKTOP_VERIFY_KIMI ?? "").trim() === "1"
const liveKimiEnv = {
  provider: process.env.DESKTOP_VERIFY_KIMI_PROVIDER?.trim() ?? "",
  apiKey: process.env.DESKTOP_VERIFY_KIMI_API_KEY?.trim() ?? "",
  model: process.env.DESKTOP_VERIFY_KIMI_MODEL?.trim() ?? "",
  baseUrl: process.env.DESKTOP_VERIFY_KIMI_BASE_URL?.trim() ?? "",
}
const hasLiveKimiCreds =
  liveKimiEnv.provider !== "" &&
  liveKimiEnv.apiKey !== "" &&
  liveKimiEnv.model !== "" &&
  liveKimiEnv.baseUrl !== ""
const kimiSubmode = isKimiMode ? (hasLiveKimiCreds ? "live" : "fixture") : null

const prompt =
  process.env.DESKTOP_VERIFY_PROMPT?.trim() ||
  (isKimiMode ? "Reply with exactly KIMI_OK." : "Reply with exactly OK.")
const fixtureAssistantText = "KIMI_OK."
const expectedAssistantText =
  process.env.DESKTOP_VERIFY_EXPECTED_TEXT?.trim() ||
  (isKimiMode ? (kimiSubmode === "fixture" ? fixtureAssistantText : "") : "OK.")
const desiredEffortMode = (process.env.DESKTOP_VERIFY_REASONING_EFFORT ?? "high").trim() || "high"
const desiredThinkingEnabled =
  (process.env.DESKTOP_VERIFY_THINKING_ENABLED ?? "true").trim().toLowerCase() === "true"

const isolatedDesktopStateRoot = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-verify-"))
const evidenceRoot = join(cwd, ".sisyphus", "evidence")
const evidenceTag = isKimiMode ? "task-20-kimi" : "task-20-default"
const evidenceJsonPath = join(evidenceRoot, `${evidenceTag}-desktop-user-path.json`)
const evidenceScreenshotPath = join(evidenceRoot, `${evidenceTag}-desktop-user-path.png`)
const evidenceReasoningScreenshotPath = join(
  evidenceRoot,
  `${evidenceTag}-desktop-reasoning-settings.png`,
)
const evidenceTracePath = join(evidenceRoot, `${evidenceTag}-desktop-user-path-trace.zip`)
const kimiAcceptanceJsonPath = join(evidenceRoot, "task-20-kimi-acceptance.json")
const task21EvidenceJsonPath = join(evidenceRoot, `${evidenceTag}-telemetry-sqlite-evidence.json`)
const task21TelemetrySuccessPath = join(evidenceRoot, "task-21-telemetry-success.txt")
const task21TelemetrySourcesPath = join(evidenceRoot, "task-21-telemetry-sources.txt")

mkdirSync(evidenceRoot, { recursive: true })

let kimiFixtureServerState = null
const desiredLlmConfig = await resolveDesiredLlmConfig()

const launchEnv = {
  ...process.env,
  DESKTOP_SELECTION_STATE_PATH:
    process.env.DESKTOP_SELECTION_STATE_PATH?.trim() ||
    join(isolatedDesktopStateRoot, "desktop-state.json"),
  DESKTOP_SETTINGS_STATE_PATH:
    process.env.DESKTOP_SETTINGS_STATE_PATH?.trim() ||
    join(isolatedDesktopStateRoot, "desktop-settings.json"),
  NCOWORKER_SERVER_DB_PATH:
    process.env.NCOWORKER_SERVER_DB_PATH?.trim() ||
    process.env.AGENT_SERVER_DB_PATH?.trim() ||
    join(isolatedDesktopStateRoot, "server.sqlite"),
}

const app = await electron.launch({
  args: ["src/desktop/electron/main.mjs"],
  cwd,
  env: launchEnv,
})

let traceStarted = false
const evidence = {
  mode: isKimiMode ? "kimi" : "default",
  kimiSubmode,
  isolatedDesktopStateRoot,
  evidenceJsonPath,
  evidenceScreenshotPath,
  evidenceReasoningScreenshotPath,
  evidenceTracePath: null,
  kimiAcceptanceJsonPath: isKimiMode ? kimiAcceptanceJsonPath : null,
  desiredThinkingEnabled,
  desiredEffortMode,
  desiredLlmConfig: desiredLlmConfig
    ? {
        provider: desiredLlmConfig.provider,
        model: desiredLlmConfig.model,
        baseURL: desiredLlmConfig.baseURL,
        apiKeyPreview: desiredLlmConfig.apiKey ? `${desiredLlmConfig.apiKey.slice(0, 4)}…` : null,
        editedFields: [],
      }
    : null,
  reasoningInteraction: {
    settingsBefore: null,
    thinkingControlVisible: false,
    effortControlVisible: false,
    appliedThinkingEnabled: null,
    appliedEffortMode: null,
    settingsAfter: null,
  },
  workspaceRoot: null,
  settingsSnapshot: null,
  appliedSettings: false,
  sessionId: null,
  latestRunStatus: null,
  transcriptCount: 0,
  assistantPreview: null,
  fixtureProviderRequests: 0,
  task21EvidenceJsonPath,
  task21TelemetrySuccessPath: isKimiMode ? task21TelemetrySuccessPath : null,
  task21TelemetrySourcesPath: isKimiMode ? task21TelemetrySourcesPath : null,
  task21: null,
}

const page = await app.firstWindow()

const traceContext = page.context()
try {
  await traceContext.tracing.start({
    name: evidenceTag,
    screenshots: true,
    snapshots: true,
    sources: false,
  })
  traceStarted = true
} catch {
  traceStarted = false
}

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

try {
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => document.body.innerText.includes("NeoCoworker"), null, {
    timeout: 20_000,
  })

  await page.getByRole("button", { name: /Settings|设置/ }).click()
  await page.waitForSelector("text=.ncoworker/desktop-settings.json", { timeout: 10_000 })
  const settingsSnapshot = await page.evaluate(() => {
    const bridge = window.neoCoworkerDesktop
    if (!bridge.loadDesktopSettings) {
      return {
        language: null,
        provider: null,
        model: null,
        baseURL: null,
        thinkingEnabled: null,
        reasoningEffortMode: null,
      }
    }

    return bridge.loadDesktopSettings().then((result) => {
      const settings = result?.settings ?? null

      return {
        language: settings?.language ?? null,
        provider: settings?.provider ?? null,
        model: settings?.model ?? null,
        baseURL: settings?.baseURL ?? null,
        thinkingEnabled: settings?.thinkingEnabled ?? null,
        reasoningEffortMode: settings?.reasoningEffortMode ?? null,
      }
    })
  })
  evidence.settingsSnapshot = settingsSnapshot
  evidence.reasoningInteraction.settingsBefore = {
    thinkingEnabled: settingsSnapshot?.thinkingEnabled ?? null,
    reasoningEffortMode: settingsSnapshot?.reasoningEffortMode ?? null,
  }

  let appliedSettings = false
  const shouldEnterLlmTab = Boolean(desiredLlmConfig) || Boolean(settingsSnapshot.provider && settingsSnapshot.model)
  if (shouldEnterLlmTab) {
    await page.getByRole("button", { name: /LLM Settings|LLM 设置/ }).click()

    if (desiredLlmConfig) {
      const editedFields = await editLlmFields(page, {
        previous: settingsSnapshot,
        next: desiredLlmConfig,
      })
      evidence.desiredLlmConfig.editedFields = editedFields
    }

    const reasoningInteraction = await driveReasoningControls(page, {
      thinkingEnabled: desiredThinkingEnabled,
      effortMode: desiredEffortMode,
    })
    evidence.reasoningInteraction.thinkingControlVisible = reasoningInteraction.thinkingClicked
    evidence.reasoningInteraction.effortControlVisible = reasoningInteraction.effortClicked
    evidence.reasoningInteraction.appliedThinkingEnabled = reasoningInteraction.thinkingClicked
      ? desiredThinkingEnabled
      : null
    evidence.reasoningInteraction.appliedEffortMode = reasoningInteraction.effortClicked
      ? desiredEffortMode
      : null

    await page.screenshot({ path: evidenceReasoningScreenshotPath, fullPage: true })

    await page.getByRole("button", { name: /Apply LLM Settings|应用 LLM 设置/ }).click()
    await page.waitForFunction(
      () => document.body.innerText.includes("Applying") === false && document.body.innerText.includes("应用中") === false,
      null,
      { timeout: 30_000 },
    )

    const sessionsHealthcheck = await requestJson("/sessions")
    if (!sessionsHealthcheck.ok) {
      throw new Error("Desktop settings apply did not leave the managed app-server reachable.")
    }
    appliedSettings = true

    const settingsAfter = await page.evaluate(() => {
      const bridge = window.neoCoworkerDesktop
      if (!bridge.loadDesktopSettings) {
        return null
      }

      return bridge.loadDesktopSettings().then((result) => {
        const settings = result?.settings ?? null
        return {
          provider: settings?.provider ?? null,
          model: settings?.model ?? null,
          baseURL: settings?.baseURL ?? null,
          thinkingEnabled: settings?.thinkingEnabled ?? null,
          reasoningEffortMode: settings?.reasoningEffortMode ?? null,
        }
      })
    })
    evidence.reasoningInteraction.settingsAfter = {
      thinkingEnabled: settingsAfter?.thinkingEnabled ?? null,
      reasoningEffortMode: settingsAfter?.reasoningEffortMode ?? null,
    }

    if (desiredLlmConfig) {
      assertPersistedLlmField("provider", settingsAfter?.provider, desiredLlmConfig.provider)
      assertPersistedLlmField("model", settingsAfter?.model, desiredLlmConfig.model)
      assertPersistedLlmField("baseURL", settingsAfter?.baseURL, desiredLlmConfig.baseURL)
    }

    if (reasoningInteraction.thinkingClicked && settingsAfter?.thinkingEnabled !== desiredThinkingEnabled) {
      throw new Error(
        `Reasoning thinking control did not persist (expected ${desiredThinkingEnabled}, got ${String(settingsAfter?.thinkingEnabled)}).`,
      )
    }
    if (reasoningInteraction.effortClicked && settingsAfter?.reasoningEffortMode !== desiredEffortMode) {
      throw new Error(
        `Reasoning effort control did not persist (expected ${desiredEffortMode}, got ${String(settingsAfter?.reasoningEffortMode)}).`,
      )
    }
  }
  evidence.appliedSettings = appliedSettings
  await page.getByRole("button", { name: /^Close$|^关闭$/ }).click()

  const workspaceRoot = await page.evaluate(
    () =>
      window.neoCoworkerDesktop.persistedWorkspaceRoot ??
      window.neoCoworkerDesktop.defaultWorkspaceRoot ??
      null,
  )
  if (!workspaceRoot) {
    throw new Error("Desktop bridge did not expose a default workspace root.")
  }
  evidence.workspaceRoot = workspaceRoot

  const sessionsPath = `/workspace/sessions?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
  const beforeSessionsResponse = await requestJson(sessionsPath)
  const beforeSessions = beforeSessionsResponse.body?.data?.sessions ?? []
  const beforeIds = new Set(beforeSessions.map((session) => session.id))

  await page.getByTitle("New Session").click()

  let sessionId = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const sessionsResponse = await requestJson(sessionsPath)
    const sessions = sessionsResponse.body?.data?.sessions ?? []
    const createdSession =
      sessions.find((session) => beforeIds.has(session.id) === false) ?? null
    if (createdSession) {
      sessionId = createdSession.id
      break
    }

    await page.waitForTimeout(250)
  }

  if (!sessionId) {
    throw new Error("Desktop UI did not create a new session.")
  }
  evidence.sessionId = sessionId

  await page.locator("textarea").fill(prompt)
  await page.locator("button[type=submit]").click()

  let latestRunStatus = null
  let latestRunId = null
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const sessionResponse = await requestJson(`/sessions/${encodeURIComponent(sessionId)}`)
    const snapshot = sessionResponse.body?.data ?? null
    latestRunStatus = snapshot?.latestRun?.status ?? null
    latestRunId = snapshot?.latestRun?.id ?? latestRunId

    if (
      latestRunStatus === "completed" ||
      latestRunStatus === "failed" ||
      latestRunStatus === "cancelled"
    ) {
      break
    }

    if (latestRunStatus === "waiting_permission") {
      throw new Error("Unexpected permission request while validating the simple desktop path.")
    }

    await page.waitForTimeout(500)
  }
  evidence.latestRunStatus = latestRunStatus

  if (latestRunStatus !== "completed") {
    throw new Error(
      `Desktop run did not complete successfully (status: ${latestRunStatus ?? "missing"}).`,
    )
  }

  const transcriptResponse = await requestJson(`/sessions/${encodeURIComponent(sessionId)}/transcript`)
  const transcript = transcriptResponse.body?.data?.transcript ?? []
  evidence.transcriptCount = transcript.length
  const assistantMessage =
    [...transcript].reverse().find((message) => message.role === "assistant") ?? null
  const assistantPreview =
    assistantMessage?.parts
      ?.map((part) => (part.kind === "text" ? part.text : null))
      .filter(Boolean)
      .join("\n")
      .slice(0, 200) ??
    assistantMessage?.content?.slice(0, 200) ??
    null
  evidence.assistantPreview = assistantPreview

  if (!assistantPreview) {
    throw new Error("Assistant transcript text is empty.")
  }

  if (
    expectedAssistantText &&
    matchesExpectedAssistantText(assistantPreview, expectedAssistantText) === false
  ) {
    throw new Error(
      `Assistant transcript did not include the expected text: ${expectedAssistantText}`,
    )
  }

  await page.screenshot({ path: evidenceScreenshotPath, fullPage: true })

  if (kimiFixtureServerState) {
    evidence.fixtureProviderRequests = kimiFixtureServerState.chatCompletionRequests.length
  }

  if (!latestRunId) {
    throw new Error("Desktop session did not expose the completed run identifier.")
  }

  const runTraceResponse = await requestJson(`/runs/${encodeURIComponent(latestRunId)}/trace`)
  if (!runTraceResponse.ok) {
    throw new Error("Desktop app-server did not return a run trace for Task 21 evidence.")
  }

  const trace = runTraceResponse.body?.data?.trace ?? null
  if (!trace) {
    throw new Error("Desktop app-server returned an empty run trace for Task 21 evidence.")
  }
  const sqliteEvidence = readTask21SqliteEvidence({
    databasePath: launchEnv.NCOWORKER_SERVER_DB_PATH,
    sessionId,
    runId: latestRunId,
  })

  const task21Evidence = buildTask21Evidence({
    mode: evidence.mode,
    kimiSubmode,
    databasePath: launchEnv.NCOWORKER_SERVER_DB_PATH,
    runId: latestRunId,
    sessionId,
    desiredThinkingEnabled,
    desiredEffortMode,
    assistantPreview,
    trace,
    sqliteEvidence,
    fixtureState: kimiFixtureServerState,
  })
  evidence.task21 = {
    traceEventTypes: task21Evidence.traceEventTypes,
    reasoningPartCount: task21Evidence.sqliteTranscript.reasoningPartCount,
    toolCallPartCount: task21Evidence.sqliteTranscript.toolCallPartCount,
    toolResultPartCount: task21Evidence.sqliteTranscript.toolResultPartCount,
    failureSignaturePresent: task21Evidence.failureSignature.present,
    kimiReplayValidated: task21Evidence.kimiReplayValidation?.validated ?? false,
  }

  if (traceStarted) {
    try {
      await traceContext.tracing.stop({ path: evidenceTracePath })
      evidence.evidenceTracePath = evidenceTracePath
      traceStarted = false
    } catch {
      evidence.evidenceTracePath = null
      traceStarted = false
    }
  }

  writeFileSync(evidenceJsonPath, `${JSON.stringify(evidence, null, 2)}\n`)
  writeFileSync(task21EvidenceJsonPath, `${JSON.stringify(task21Evidence, null, 2)}\n`)

  if (isKimiMode) {
    writeFileSync(task21TelemetrySuccessPath, `${renderTask21TelemetrySuccess(task21Evidence)}\n`)
    writeFileSync(task21TelemetrySourcesPath, `${renderTask21TelemetrySources(task21Evidence)}\n`)
  }

  if (isKimiMode) {
    const kimiAcceptance = {
      mode: "kimi",
      submode: kimiSubmode,
      modelRequested: desiredLlmConfig?.model ?? null,
      providerRequested: desiredLlmConfig?.provider ?? null,
      baseUrlRequested: desiredLlmConfig?.baseURL ?? null,
      sessionId,
      latestRunStatus,
      transcriptCount: transcript.length,
      assistantPreview,
      reasoningInteraction: evidence.reasoningInteraction,
      fixtureProviderRequests: evidence.fixtureProviderRequests,
      evidenceJsonPath,
      evidenceScreenshotPath,
      evidenceReasoningScreenshotPath,
      evidenceTracePath: evidence.evidenceTracePath,
      task21EvidenceJsonPath,
      task21TelemetrySuccessPath,
      task21TelemetrySourcesPath,
    }
    writeFileSync(kimiAcceptanceJsonPath, `${JSON.stringify(kimiAcceptance, null, 2)}\n`)
  }

  console.log(
    JSON.stringify(
      {
        mode: evidence.mode,
        kimiSubmode,
        workspaceRoot,
        settingsSnapshot,
        desiredLlmConfig: evidence.desiredLlmConfig,
        appliedSettings,
        reasoningInteraction: evidence.reasoningInteraction,
        sessionId,
        latestRunStatus,
        transcriptCount: transcript.length,
        assistantPreview,
        fixtureProviderRequests: evidence.fixtureProviderRequests,
        evidenceJsonPath,
        evidenceScreenshotPath,
        evidenceReasoningScreenshotPath,
        evidenceTracePath: evidence.evidenceTracePath,
        task21EvidenceJsonPath,
        task21: evidence.task21,
        kimiAcceptanceJsonPath: isKimiMode ? kimiAcceptanceJsonPath : null,
      },
      null,
      2,
    ),
  )
} finally {
  if (traceStarted) {
    try {
      await traceContext.tracing.stop({ path: evidenceTracePath })
      evidence.evidenceTracePath = evidenceTracePath
    } catch {
      evidence.evidenceTracePath = null
    }
  }
  await app.close()
  if (kimiFixtureServerState) {
    await stopHttpServer(kimiFixtureServerState.server)
  }
}

async function resolveDesiredLlmConfig() {
  if (!isKimiMode) {
    return null
  }

  if (hasLiveKimiCreds) {
    return {
      provider: liveKimiEnv.provider,
      apiKey: liveKimiEnv.apiKey,
      model: liveKimiEnv.model,
      baseURL: liveKimiEnv.baseUrl,
    }
  }

  // Deterministic Kimi mode: spin up a loopback OpenAI-compatible mock server
  // so we can edit provider/model/baseURL through the real desktop UI flow and
  // still complete a real run end-to-end against the kimi-k2.6 model name.
  const port = await allocateLoopbackPort()
  const fixtureServer = await startKimiFixtureServer({ port, assistantText: fixtureAssistantText })
  kimiFixtureServerState = {
    server: fixtureServer.server,
    port,
    ...fixtureServer.state,
  }
  return {
    provider: "openai-compatible",
    apiKey: "kimi-fixture-key",
    model: "kimi-k2.6",
    baseURL: `http://127.0.0.1:${port}/v1`,
  }
}

async function editLlmFields(page, input) {
  const edited = []
  if (input.next.provider && input.next.provider !== input.previous.provider) {
    await chooseProvider(page, input.next.provider)
    edited.push("provider")
  }

  if (input.next.apiKey) {
    await fillFieldByLabel(page, /^(API key|API Key)$/, input.next.apiKey, { type: "password" })
    edited.push("apiKey")
  }

  if (input.next.model && input.next.model !== input.previous.model) {
    await fillFieldByLabel(page, /^(Model|模型)$/, input.next.model)
    edited.push("model")
  }

  if (input.next.baseURL && input.next.baseURL !== input.previous.baseURL) {
    await fillFieldByLabel(page, /^Base URL$/, input.next.baseURL)
    edited.push("baseURL")
  }

  return edited
}

async function chooseProvider(page, providerValue) {
  const trigger = await locateLabeledTrigger(page, /^(LLM provider|LLM 提供商)$/)
  if (!trigger) {
    throw new Error("Could not locate the LLM provider select trigger.")
  }
  await trigger.click()
  await page.waitForTimeout(120)
  const option = page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(providerValue)}$`) })
    .first()
  await option.waitFor({ timeout: 5_000 })
  await option.click()
  await page.waitForTimeout(120)
}

async function fillFieldByLabel(page, labelPattern, value, options) {
  const label = page
    .locator("label")
    .filter({ has: page.locator("span", { hasText: labelPattern }) })
    .first()
  if ((await label.count()) === 0) {
    throw new Error(`Could not locate input with label ${labelPattern}.`)
  }
  const inputSelector = options?.type === "password" ? "input[type=\"password\"]" : "input:not([type=\"password\"])"
  const input = label.locator(inputSelector).first()
  await input.waitFor({ timeout: 5_000 })
  await input.fill("")
  await input.fill(value)
}

function assertPersistedLlmField(fieldName, actual, expected) {
  if (!expected) {
    return
  }
  if (actual !== expected) {
    throw new Error(
      `Desktop LLM ${fieldName} did not persist (expected ${expected}, got ${String(actual)}).`,
    )
  }
}

async function driveReasoningControls(page, input) {
  const interaction = { thinkingClicked: false, effortClicked: false }
  // The Reasoning controls render under the LLM Settings tab as
  // `<label><span>Enable thinking</span><SettingsSelect /></label>` and
  // `<label><span>Reasoning effort</span><SettingsSelect /></label>`.
  // The capability prop may hide one or both controls; we treat that as a
  // soft skip so deterministic mode still works on conservative-default models.
  const thinkingTrigger = await locateLabeledTrigger(page, /Enable thinking|启用思考/)
  if (thinkingTrigger) {
    await thinkingTrigger.click()
    await page.waitForTimeout(120)
    const desiredOptionPattern = input.thinkingEnabled
      ? /^On$|^开$/
      : /^Off$|^关$/
    const option = page.getByRole("option", { name: desiredOptionPattern }).first()
    await option.waitFor({ timeout: 5_000 })
    await option.click()
    await page.waitForTimeout(120)
    interaction.thinkingClicked = true
  }

  const effortTrigger = await locateLabeledTrigger(page, /Reasoning effort|推理强度/)
  if (effortTrigger) {
    await effortTrigger.click()
    await page.waitForTimeout(120)
    const optionPattern = effortOptionPattern(input.effortMode)
    const option = page.getByRole("option", { name: optionPattern }).first()
    await option.waitFor({ timeout: 5_000 })
    await option.click()
    await page.waitForTimeout(120)
    interaction.effortClicked = true
  }

  return interaction
}

async function locateLabeledTrigger(page, labelPattern) {
  const labelLocator = page
    .locator("label")
    .filter({ has: page.locator("span", { hasText: labelPattern }) })
    .first()
  if ((await labelLocator.count()) === 0) {
    return null
  }
  const trigger = labelLocator.locator("button[aria-haspopup=\"listbox\"]").first()
  if ((await trigger.count()) === 0) {
    return null
  }
  return trigger
}

function effortOptionPattern(effortMode) {
  switch (effortMode) {
    case "default":
      return /^Default$|^默认$/
    case "low":
      return /^Low$|^低$/
    case "medium":
      return /^Medium$|^中$/
    case "high":
      return /^High$|^高$/
    default:
      return new RegExp(`^${escapeRegExp(effortMode)}$`)
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function matchesExpectedAssistantText(actualText, expectedText) {
  if (actualText.includes(expectedText)) {
    return true
  }

  return normalizeAssistantText(actualText).includes(normalizeAssistantText(expectedText))
}

function normalizeAssistantText(text) {
  return text.trim().replace(/[.!?。！？]+$/gu, "")
}

async function allocateLoopbackPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createHttpServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : null
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolvePort(port)
      })
    })
  })
}

async function startKimiFixtureServer(input) {
  const state = {
    chatCompletionRequests: [],
    modelsRequestCount: 0,
  }
  const server = createHttpServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = await readJsonBody(request)
      state.chatCompletionRequests.push(body)
      const requestIndex = state.chatCompletionRequests.length

      if (requestIndex === 1) {
        if (body?.thinking?.type !== "enabled" || body?.thinking?.keep !== "all") {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "thinking.keep=all is required for kimi-k2.6 fixture validation" } }))
          return
        }

        if (body?.reasoning_effort !== "high") {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "reasoning_effort=high is required for kimi-k2.6 fixture validation" } }))
          return
        }

        writeSseResponse(response, [
          openAiChunk({
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: {
                  role: "assistant",
                  reasoning_content: "Need to inspect README.md before finishing.",
                },
              },
            ],
          }),
          openAiChunk({
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_fixture_readme",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: '{"path":"READ',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          openAiChunk({
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: 'ME.md"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          openAiChunk({
            choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }],
          }),
          openAiUsageChunk(40, 8),
        ])
        return
      }

      if (requestIndex === 2) {
        const replayValidation = validateKimiReplayRequest(body)
        if (!replayValidation.ok) {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              error: {
                message: replayValidation.error,
              },
            }),
          )
          return
        }

        writeSseResponse(response, [
          openAiChunk({
            choices: [
              {
                index: 0,
                finish_reason: null,
                delta: { role: "assistant", content: input.assistantText },
              },
            ],
          }),
          openAiChunk({
            choices: [{ index: 0, finish_reason: "stop", delta: {} }],
          }),
          openAiUsageChunk(58, 8),
        ])
        return
      }

      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: `Unexpected extra kimi fixture request #${requestIndex}` } }))
      return
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      state.modelsRequestCount += 1
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          data: [{ id: "kimi-k2.6", object: "model", context_length: 65536 }],
        }),
      )
      return
    }

    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: `Unknown route: ${request.method} ${request.url}` } }))
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(undefined)
    })
  })

  return {
    server,
    state,
  }
}

function openAiChunk(input) {
  return {
    id: `chatcmpl_task20_${Date.now()}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "kimi-k2.6",
    choices: input.choices,
  }
}

function openAiUsageChunk(promptTokens, completionTokens) {
  return {
    id: `chatcmpl_task20_usage_${Date.now()}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "kimi-k2.6",
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

function writeSseResponse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  })

  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  response.end("data: [DONE]\n\n")
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const body = Buffer.concat(chunks).toString("utf8")
  return body ? JSON.parse(body) : null
}

function validateKimiReplayRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const assistantReplay = messages.find(
    (message) =>
      message?.role === "assistant" &&
      Array.isArray(message?.tool_calls) &&
      message.tool_calls.length > 0,
  )
  if (!assistantReplay || typeof assistantReplay.reasoning_content !== "string" || assistantReplay.reasoning_content.trim() === "") {
    return {
      ok: false,
      error: "400 thinking is enabled but reasoning_content is missing in assistant tool call message at index 3",
    }
  }

  const toolReplay = messages.find(
    (message) =>
      message?.role === "tool" &&
      message?.tool_call_id === "call_fixture_readme" &&
      typeof message?.content === "string" &&
      message.content.trim() !== "",
  )
  if (!toolReplay) {
    return {
      ok: false,
      error: "400 tool replay content is missing for kimi fixture validation",
    }
  }

  if (body?.thinking?.type !== "enabled" || body?.thinking?.keep !== "all") {
    return {
      ok: false,
      error: "400 thinking preservation is missing for kimi fixture validation",
    }
  }

  return {
    ok: true,
  }
}

function readTask21SqliteEvidence(input) {
  const pythonScript = String.raw`
import json
import sqlite3
import sys

database_path, session_id, run_id = sys.argv[1:4]
failure_signature = "reasoning_content is missing"
connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row

run_row = connection.execute(
    "SELECT id, status, error_text, input_tokens, output_tokens, token_usage_source FROM run WHERE id = ?",
    (run_id,),
).fetchone()
if run_row is None:
    raise SystemExit(f"Run not found in sqlite evidence query: {run_id}")

event_rows = connection.execute(
    "SELECT sequence, source, event_type, data_json FROM run_event WHERE run_id = ? ORDER BY sequence ASC",
    (run_id,),
).fetchall()
message_rows = connection.execute(
    "SELECT id, role FROM message WHERE session_id = ? ORDER BY created_at ASC, sequence ASC, id ASC",
    (session_id,),
).fetchall()
part_rows = connection.execute(
    "SELECT message_id, kind, text_value FROM part WHERE session_id = ? ORDER BY created_at ASC, sequence ASC, id ASC",
    (session_id,),
).fetchall()

message_kinds = {}
reasoning_count = 0
tool_call_count = 0
tool_result_count = 0
part_text_failure_signature_present = False
for row in part_rows:
    message_kinds.setdefault(row["message_id"], set()).add(row["kind"])
    if row["kind"] == "reasoning":
        reasoning_count += 1
    if row["kind"] == "tool_call":
        tool_call_count += 1
    if row["kind"] == "tool_result":
        tool_result_count += 1
    if isinstance(row["text_value"], str) and failure_signature in row["text_value"]:
        part_text_failure_signature_present = True

message_role_by_id = {row["id"]: row["role"] for row in message_rows}
assistant_reasoning_replay_message_count = 0
for message_id, kinds in message_kinds.items():
    if message_role_by_id.get(message_id) == "assistant" and "reasoning" in kinds and "tool_call" in kinds:
        assistant_reasoning_replay_message_count += 1

events = []
run_event_failure_signature_present = False
for row in event_rows:
    data = json.loads(row["data_json"]) if row["data_json"] else {}
    if failure_signature in row["data_json"]:
        run_event_failure_signature_present = True
    events.append(
        {
            "sequence": row["sequence"],
            "source": row["source"],
            "eventType": row["event_type"],
            "data": data,
        }
    )

result = {
    "run": {
        "id": run_row["id"],
        "status": run_row["status"],
        "errorText": run_row["error_text"],
        "inputTokens": run_row["input_tokens"],
        "outputTokens": run_row["output_tokens"],
        "tokenUsageSource": run_row["token_usage_source"],
    },
    "runEvents": events,
    "traceEventTypes": [event["eventType"] for event in events],
    "transcriptSummary": {
        "messageCount": len(message_rows),
        "reasoningPartCount": reasoning_count,
        "toolCallPartCount": tool_call_count,
        "toolResultPartCount": tool_result_count,
        "assistantReasoningReplayMessageCount": assistant_reasoning_replay_message_count,
    },
    "failureSignature": {
        "value": failure_signature,
        "presentInRunError": isinstance(run_row["error_text"], str) and failure_signature in run_row["error_text"],
        "presentInRunEvents": run_event_failure_signature_present,
        "presentInPartText": part_text_failure_signature_present,
    },
}

print(json.dumps(result))
`
  const result = spawnSync("python", ["-c", pythonScript, input.databasePath, input.sessionId, input.runId], {
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(
      `Task 21 sqlite evidence query failed: ${(result.stderr || result.stdout || "unknown sqlite evidence error").trim()}`,
    )
  }

  return JSON.parse(result.stdout)
}

function buildTask21Evidence(input) {
  const traceEvents = Array.isArray(input.trace?.events) ? input.trace.events : []
  const traceEventTypes = traceEvents.map((event) => event.eventType)
  const serializedTrace = JSON.stringify(input.trace)
  const sqliteRunEvents = Array.isArray(input.sqliteEvidence?.runEvents) ? input.sqliteEvidence.runEvents : []
  const sqliteTraceEventTypes = Array.isArray(input.sqliteEvidence?.traceEventTypes)
    ? input.sqliteEvidence.traceEventTypes
    : []
  const capabilityEvent = sqliteRunEvents.find((event) => event.eventType === "capability.resolution.recorded")?.data ?? null
  const contextWindowEvent = sqliteRunEvents.find((event) => event.eventType === "context.window.resolved")?.data ?? null
  const kimiClassification = sqliteRunEvents.find((event) => event.eventType === "kimi.run.classified")?.data ?? null
  const kimiReplayValidation = buildKimiReplayValidation(input.fixtureState)
  const failureSignature = input.sqliteEvidence?.failureSignature?.value ?? "reasoning_content is missing"

  if (JSON.stringify(traceEventTypes) !== JSON.stringify(sqliteTraceEventTypes)) {
    throw new Error("Task 21 evidence mismatch: exported run trace event order differs from sqlite run_event rows.")
  }

  assertTraceEvent(traceEventTypes, "capability.resolution.recorded")
  assertTraceEvent(traceEventTypes, "context.window.resolved")
  assertTraceEvent(traceEventTypes, "run.completed")

  if (input.mode === "kimi") {
    assertTraceEvent(traceEventTypes, "kimi.run.classified")
    if (traceEventTypes.filter((eventType) => eventType === "model.turn.requested").length < 2) {
      throw new Error("Kimi fixture evidence did not record the expected replay follow-up model turn.")
    }
    if (traceEventTypes.includes("replay.fail_fast.blocked")) {
      throw new Error("Kimi fixture evidence unexpectedly recorded replay.fail_fast.blocked on a successful run.")
    }
    if ((input.sqliteEvidence?.transcriptSummary?.assistantReasoningReplayMessageCount ?? 0) < 1) {
      throw new Error("Kimi fixture transcript did not persist an assistant reasoning+tool_call message for sqlite-backed replay evidence.")
    }
    assertExactCapabilityTelemetry(capabilityEvent)
    assertExactContextTelemetry(contextWindowEvent)
    if (kimiClassification?.outcome !== "success") {
      throw new Error(`Kimi fixture run classification was not successful (got ${String(kimiClassification?.outcome)}).`)
    }
    if (!kimiReplayValidation.validated) {
      throw new Error("Kimi fixture did not validate reasoning replay from the real desktop provider request.")
    }
  }

  const failureSignaturePresent =
    input.sqliteEvidence?.failureSignature?.presentInRunError === true ||
    input.sqliteEvidence?.failureSignature?.presentInRunEvents === true ||
    input.sqliteEvidence?.failureSignature?.presentInPartText === true ||
    serializedTrace.includes(failureSignature) ||
    String(input.assistantPreview ?? "").includes(failureSignature)
  if (failureSignaturePresent) {
    throw new Error("Successful desktop evidence still contains the original reasoning_content failure signature.")
  }

  return {
    mode: input.mode,
    kimiSubmode: input.kimiSubmode,
    databasePath: input.databasePath,
    sessionId: input.sessionId,
    runId: input.runId,
    desiredThinkingEnabled: input.desiredThinkingEnabled,
    desiredEffortMode: input.desiredEffortMode,
    assistantPreview: input.assistantPreview,
    run: input.sqliteEvidence?.run ?? null,
    traceEventTypes,
    failureSignature: {
      value: failureSignature,
      present: false,
      sqlite: input.sqliteEvidence?.failureSignature ?? null,
    },
    capabilityResolution: capabilityEvent,
    contextWindow: contextWindowEvent,
    kimiRunClassification: kimiClassification,
    sqliteTranscript: input.sqliteEvidence?.transcriptSummary ?? null,
    kimiReplayValidation,
  }
}

function buildKimiReplayValidation(fixtureState) {
  if (!fixtureState) {
    return null
  }

  const [firstRequest, secondRequest] = fixtureState.chatCompletionRequests
  const secondMessages = Array.isArray(secondRequest?.messages) ? secondRequest.messages : []
  const replayAssistant = secondMessages.find(
    (message) => message?.role === "assistant" && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
  )
  const toolReplay = secondMessages.find(
    (message) => message?.role === "tool" && message?.tool_call_id === "call_fixture_readme",
  )

  return {
    validated: fixtureState.chatCompletionRequests.length >= 2 && typeof replayAssistant?.reasoning_content === "string",
    chatCompletionRequestCount: fixtureState.chatCompletionRequests.length,
    modelsRequestCount: fixtureState.modelsRequestCount,
    firstRequestThinking: firstRequest?.thinking ?? null,
    firstRequestReasoningEffort: firstRequest?.reasoning_effort ?? null,
    secondRequestHasReasoningContentReplay: typeof replayAssistant?.reasoning_content === "string",
    secondRequestAssistantToolReplayCount: Array.isArray(replayAssistant?.tool_calls) ? replayAssistant.tool_calls.length : 0,
    secondRequestHasToolResultReplay: typeof toolReplay?.content === "string",
  }
}

function assertTraceEvent(traceEventTypes, eventType) {
  if (!traceEventTypes.includes(eventType)) {
    throw new Error(`Desktop Task 21 evidence is missing the ${eventType} trace event.`)
  }
}

function assertExactCapabilityTelemetry(eventData) {
  const expected = {
    model: "kimi-k2.6",
    provider: "openai-compatible",
    providerFamily: "kimi",
    catalogSource: "models.dev",
    catalogMiss: false,
    reasoningSource: "models.dev",
    toolCallSource: "models.dev",
    interleavedSource: "models.dev",
    interleavedField: "reasoning_content",
    reasoningEffortSource: "models.dev",
    thinkingSource: "config",
    thinkingEffortSource: "config",
  }
  const actual = JSON.stringify(eventData)
  const expectedJson = JSON.stringify(expected)
  if (actual !== expectedJson) {
    throw new Error(`Kimi capability telemetry did not match the expected authoritative sources. Got ${actual}`)
  }
}

function assertExactContextTelemetry(eventData) {
  const expected = {
    contextWindow: 262144,
    source: "models.dev",
  }
  const actual = JSON.stringify(eventData)
  const expectedJson = JSON.stringify(expected)
  if (actual !== expectedJson) {
    throw new Error(`Kimi context-window telemetry did not match the expected /models source. Got ${actual}`)
  }
}

function renderTask21TelemetrySuccess(task21Evidence) {
  return [
    `mode=${task21Evidence.mode}`,
    `kimiSubmode=${task21Evidence.kimiSubmode}`,
    `runId=${task21Evidence.runId}`,
    `traceEventTypes=${task21Evidence.traceEventTypes.join(",")}`,
    `failureSignature=${task21Evidence.failureSignature.value}`,
    `failureSignaturePresent=${String(task21Evidence.failureSignature.present)}`,
    `assistantReasoningReplayMessageCount=${task21Evidence.sqliteTranscript.assistantReasoningReplayMessageCount}`,
    `reasoningPartCount=${task21Evidence.sqliteTranscript.reasoningPartCount}`,
    `toolCallPartCount=${task21Evidence.sqliteTranscript.toolCallPartCount}`,
    `toolResultPartCount=${task21Evidence.sqliteTranscript.toolResultPartCount}`,
    `chatCompletionRequestCount=${String(task21Evidence.kimiReplayValidation?.chatCompletionRequestCount ?? 0)}`,
    `secondRequestHasReasoningContentReplay=${String(task21Evidence.kimiReplayValidation?.secondRequestHasReasoningContentReplay ?? false)}`,
  ].join("\n")
}

function renderTask21TelemetrySources(task21Evidence) {
  return [
    `mode=${task21Evidence.mode}`,
    `model=${String(task21Evidence.capabilityResolution?.model ?? "")}`,
    `provider=${String(task21Evidence.capabilityResolution?.provider ?? "")}`,
    `providerFamily=${String(task21Evidence.capabilityResolution?.providerFamily ?? "")}`,
    `catalogSource=${String(task21Evidence.capabilityResolution?.catalogSource ?? "")}`,
    `reasoningSource=${String(task21Evidence.capabilityResolution?.reasoningSource ?? "")}`,
    `toolCallSource=${String(task21Evidence.capabilityResolution?.toolCallSource ?? "")}`,
    `interleavedSource=${String(task21Evidence.capabilityResolution?.interleavedSource ?? "")}`,
    `interleavedField=${String(task21Evidence.capabilityResolution?.interleavedField ?? "")}`,
    `thinkingSource=${String(task21Evidence.capabilityResolution?.thinkingSource ?? "")}`,
    `thinkingEffortSource=${String(task21Evidence.capabilityResolution?.thinkingEffortSource ?? "")}`,
    `contextWindow=${String(task21Evidence.contextWindow?.contextWindow ?? "")}`,
    `contextSource=${String(task21Evidence.contextWindow?.source ?? "")}`,
  ].join("\n")
}

async function stopHttpServer(server) {
  if (!server) {
    return
  }
  await new Promise((resolve) => {
    server.close(() => resolve(undefined))
  })
}
