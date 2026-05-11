import { _electron as electron } from "playwright"
import { spawn } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const cwd = process.cwd()
const isolatedDesktopStateRoot = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-subsession-verify-"))
const workspaceRoot = join(isolatedDesktopStateRoot, "workspace")
const evidenceRoot = join(cwd, ".sisyphus", "evidence")
const serverDatabasePath = join(isolatedDesktopStateRoot, "server.sqlite")
const evidenceJsonPath = join(evidenceRoot, "task-12-sidebar-sessions.json")
const timelineEvidencePath = join(evidenceRoot, "task-12-desktop-timeline.json")
const screenshotPath = join(evidenceRoot, "task-12-buttons-test.png")
const readmeFixtureText = "Task 12 README fixture: subagent-only marker."
const parentPrompt =
  "Use the agent tool to delegate README inspection to explore. Return only the delegated summary."
const delegatedPrompt = "Inspect README.md and return only the delegated summary."
const subagentInternalMarker = "TASK12_SUBAGENT_INTERNAL_MARKER"
const delegatedSummary = "Delegated summary for parent."
const parentFinalText = "Parent finished after delegated work."

mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(evidenceRoot, { recursive: true })
writeFileSync(join(workspaceRoot, "README.md"), `# demo workspace\n\n${readmeFixtureText}\n`)

const mockRequests = []
const childStdout = []
const childStderr = []

let mockServer = null
let appServerProcess = null
let app = null

try {
  const mockPort = await allocateLoopbackPort()
  const appServerPort = await allocateLoopbackPort()
  mockServer = await startMockModelServer({
    port: mockPort,
    requests: mockRequests,
  })

  const appServerOrigin = `http://127.0.0.1:${appServerPort}`
  appServerProcess = spawn("bun", ["run", "src/app-server/main.ts"], {
    cwd,
    env: buildLoopbackEnv({
      NCOWORKER_SERVER_HOST: "127.0.0.1",
      NCOWORKER_SERVER_PORT: String(appServerPort),
      NCOWORKER_SERVER_DB_PATH: serverDatabasePath,
      LLM_PROVIDER: "openai-compatible",
      LLM_API_KEY: "task-12-mock-key",
      LLM_MODEL: "task-12-mock-model",
      LLM_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      LLM_CONTEXT_WINDOW: "65536",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  appServerProcess.stdout?.setEncoding("utf8")
  appServerProcess.stderr?.setEncoding("utf8")
  appServerProcess.stdout?.on("data", (chunk) => childStdout.push(chunk))
  appServerProcess.stderr?.on("data", (chunk) => childStderr.push(chunk))
  appServerProcess.on("exit", (code, signal) => {
    if (code !== null || signal !== null) {
      childStderr.push(`\n[app-server exited code=${code ?? "null"} signal=${signal ?? "null"}]`)
    }
  })

  await waitForJsonOk(`${appServerOrigin}/sessions`, 20_000)

  app = await electron.launch({
    args: ["src/desktop/electron/main.mjs"],
    cwd,
    env: {
      ...process.env,
      DESKTOP_WORKSPACE_ROOT: workspaceRoot,
      DESKTOP_SELECTION_STATE_PATH: join(isolatedDesktopStateRoot, "desktop-state.json"),
      DESKTOP_SETTINGS_STATE_PATH: join(isolatedDesktopStateRoot, "desktop-settings.json"),
      AGENT_SERVER_URL: appServerOrigin,
      NCOWORKER_SERVER_DB_PATH: serverDatabasePath,
    },
  })

  const page = await app.firstWindow()

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

  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => document.body.innerText.includes("NeoCoworker"), null, {
    timeout: 20_000,
  })
  await page.waitForFunction(() => Boolean(window.neoCoworkerDesktop?.requestJson), null, {
    timeout: 20_000,
  })

  const bridgeWorkspaceRoot = await page.evaluate(
    () =>
      window.neoCoworkerDesktop.persistedWorkspaceRoot ??
      window.neoCoworkerDesktop.defaultWorkspaceRoot ??
      null,
  )
  assert(
    bridgeWorkspaceRoot === workspaceRoot,
    `Desktop bridge did not expose the isolated workspace root (${bridgeWorkspaceRoot ?? "missing"}).`,
  )

  await page.getByRole("button", { name: /Settings|设置/ }).click()
  await page.waitForSelector("text=.ncoworker/desktop-settings.json", { timeout: 10_000 })
  const settingsSnapshot = await page.evaluate(() => {
    return window.neoCoworkerDesktop.loadDesktopSettings?.().then((result) => result ?? null) ?? null
  })
  assert(settingsSnapshot?.serverMode === "external", "Desktop did not start in external server mode.")
  await page.getByRole("button", { name: /^Close$|^关闭$/ }).click()

  const sessionsPath = `/workspace/sessions?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
  const beforeSessionsResponse = await requestJson(sessionsPath)
  const beforeSessions = unwrapSessions(beforeSessionsResponse, "list workspace sessions before UI create")
  const beforeIds = new Set(beforeSessions.map((session) => session.id))

  await page.getByTitle("New Session").click()

  let parentSessionId = null
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const sessionsResponse = await requestJson(sessionsPath)
    const sessions = unwrapSessions(sessionsResponse, "poll workspace sessions after UI create")
    const createdSession = sessions.find((session) => beforeIds.has(session.id) === false) ?? null
    if (createdSession) {
      parentSessionId = createdSession.id
      break
    }

    await page.waitForTimeout(250)
  }

  assert(parentSessionId, "Desktop UI did not create a new parent session.")

  await page.locator("textarea").fill(parentPrompt)
  await page.locator("button[type=submit]").click()

  let latestRunStatus = null
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const sessionResponse = await requestJson(`/sessions/${encodeURIComponent(parentSessionId)}`)
    const snapshot = sessionResponse.body?.data ?? null
    latestRunStatus = snapshot?.latestRun?.status ?? null

    if (
      latestRunStatus === "completed" ||
      latestRunStatus === "failed" ||
      latestRunStatus === "cancelled"
    ) {
      break
    }

    if (latestRunStatus === "waiting_permission") {
      throw new Error("Unexpected permission request while validating the desktop subsession path.")
    }

    await page.waitForTimeout(500)
  }

  assert(
    latestRunStatus === "completed",
    `Desktop run did not complete successfully (status: ${latestRunStatus ?? "missing"}).\n${formatProcessLogs(childStdout, childStderr)}`,
  )

  const childSession = readChildSession({
    databasePath: serverDatabasePath,
    parentSessionId,
  })
  assert(childSession, "Real runtime path did not create a child SubSession.")

  const parentTimelineResponse = await requestJson(
    `/sessions/${encodeURIComponent(parentSessionId)}/timeline`,
  )
  const parentTimeline = unwrapTimeline(parentTimelineResponse, "fetch parent timeline")
  const childTimelineResponse = await requestJson(
    `/sessions/${encodeURIComponent(childSession.id)}/timeline`,
  )
  const childTimeline = unwrapTimeline(childTimelineResponse, "fetch child timeline")

  const parentTimelineJson = JSON.stringify(parentTimeline)
  const childTimelineJson = JSON.stringify(childTimeline)
  const parentVisibleText = readTimelineVisibleText(parentTimeline)
  const childVisibleText = readTimelineVisibleText(childTimeline)
  assert(
    hasTimelinePart(parentTimeline, "tool_call", "agent"),
    "Parent timeline did not contain an agent tool_call part.",
  )
  assert(
    hasTimelinePart(parentTimeline, "tool_result", "agent"),
    "Parent timeline did not contain an agent tool_result part.",
  )
  assert(
    parentVisibleText.includes(delegatedSummary),
    "Parent timeline did not include the delegated summary.",
  )
  assert(
    parentVisibleText.includes(parentFinalText),
    "Parent timeline did not include the parent completion text.",
  )
  assert(
    parentVisibleText.includes(subagentInternalMarker) === false,
    "Parent timeline leaked the subagent internal marker.",
  )
  assert(
    parentVisibleText.includes(readmeFixtureText) === false,
    "Parent timeline leaked the child README tool result.",
  )
  assert(
    childVisibleText.includes(subagentInternalMarker),
    "Child timeline did not include the subagent internal marker.",
  )
  assert(
    childVisibleText.includes(readmeFixtureText),
    "Child timeline did not include the README tool result.",
  )

  const sessionsResponse = await requestJson("/sessions")
  const topLevelSessions = unwrapSessions(sessionsResponse, "list top-level sessions after run")
  const workspaceSessionsResponse = await requestJson(sessionsPath)
  const workspaceSessions = unwrapSessions(
    workspaceSessionsResponse,
    "list workspace sessions after run",
  )
  assert(
    topLevelSessions.some((session) => session.id === childSession.id) === false,
    "GET /sessions unexpectedly returned the SubSession.",
  )
  assert(
    workspaceSessions.some((session) => session.id === childSession.id) === false,
    "GET /workspace/sessions unexpectedly returned the SubSession.",
  )

  const buttonCoverage = await exerciseVisibleControls(page, {
    parentSessionTitle: topLevelSessions.find((session) => session.id === parentSessionId)?.title ?? null,
  })
  const sidebarButtonTexts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button"))
      .map((button) => {
        const label =
          button.getAttribute("aria-label")?.trim() ||
          button.getAttribute("title")?.trim() ||
          button.innerText.replace(/\s+/gu, " ").trim()
        return label
      })
      .filter(Boolean)
  })
  assert(
    sidebarButtonTexts.includes(childSession.title) === false,
    "Desktop sidebar unexpectedly rendered the SubSession entry.",
  )

  writeFileSync(
    timelineEvidencePath,
    `${JSON.stringify(
      {
        workspaceRoot,
        parentSessionId,
        childSession,
        latestRunStatus,
        providerTurns: mockRequests.map((request, index) => ({
          turn: index + 1,
          lastMessageRole: request.messages.at(-1)?.role ?? null,
          lastMessageContent: extractMessageContent(request.messages.at(-1)),
        })),
        parentTimelineResponse,
        childTimelineResponse,
        checks: {
          parentHasAgentToolCall: hasTimelinePart(parentTimeline, "tool_call", "agent"),
          parentHasAgentToolResult: hasTimelinePart(parentTimeline, "tool_result", "agent"),
          parentVisibleTextHasChildInternalMarker: parentVisibleText.includes(subagentInternalMarker),
          parentVisibleTextHasChildReadmeMarker: parentVisibleText.includes(readmeFixtureText),
          childVisibleTextHasInternalMarker: childVisibleText.includes(subagentInternalMarker),
          childVisibleTextHasReadmeMarker: childVisibleText.includes(readmeFixtureText),
        },
      },
      null,
      2,
    )}\n`,
  )

  writeFileSync(
    evidenceJsonPath,
    `${JSON.stringify(
      {
        workspaceRoot,
        parentSessionId,
        childSession,
        runtimeMode: settingsSnapshot?.serverMode ?? null,
        sessionsResponse: sessionsResponse.body,
        workspaceSessionsResponse: workspaceSessionsResponse.body,
        sidebarButtonTexts,
        buttonCoverage,
      },
      null,
      2,
    )}\n`,
  )

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  })

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        parentSessionId,
        childSessionId: childSession.id,
        latestRunStatus,
        evidenceJsonPath,
        timelineEvidencePath,
        screenshotPath,
        buttonCoverage: {
          clicked: buttonCoverage.clicked.length,
          skipped: buttonCoverage.skipped.length,
        },
      },
      null,
      2,
    ),
  )
} finally {
  await app?.close()
  await stopChildProcess(appServerProcess)
  await stopHttpServer(mockServer)
  rmSync(isolatedDesktopStateRoot, { recursive: true, force: true })
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

function buildLoopbackEnv(overrides) {
  const env = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) {
      env[key] = String(value)
    }
  }

  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  env.NO_PROXY = "127.0.0.1,localhost"
  env.no_proxy = "127.0.0.1,localhost"

  return {
    ...env,
    ...overrides,
  }
}

async function startMockModelServer(input) {
  let turn = 0
  const server = createHttpServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = await readJsonBody(request)
      input.requests.push(body)
      turn += 1
      writeSseResponse(response, buildTurnChunks(turn))
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

  return server
}

function buildTurnChunks(turn) {
  if (turn === 1) {
    return [
      openAiChunk({
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_agent",
                  type: "function",
                  function: {
                    name: "agent",
                    arguments: JSON.stringify({ agent: "explore", prompt: delegatedPrompt }),
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
            finish_reason: "tool_calls",
            delta: {},
          },
        ],
      }),
      openAiUsageChunk(120, 16),
    ]
  }

  if (turn === 2) {
    return [
      openAiChunk({
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              content: `${subagentInternalMarker}\n`,
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
                  id: "call_sub_read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"README',
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
                    arguments: '.md"}',
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
            finish_reason: "tool_calls",
            delta: {},
          },
        ],
      }),
      openAiUsageChunk(220, 32),
    ]
  }

  if (turn === 3) {
    return [
      openAiChunk({
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              content: delegatedSummary,
            },
          },
        ],
      }),
      openAiUsageChunk(180, 14),
    ]
  }

  if (turn === 4) {
    return [
      openAiChunk({
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              content: parentFinalText,
            },
          },
        ],
      }),
      openAiUsageChunk(150, 12),
    ]
  }

  throw new Error(`Unexpected mock provider turn ${turn}`)
}

function openAiChunk(input) {
  return {
    id: `chatcmpl_task12_${Date.now()}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "task-12-mock-model",
    choices: input.choices,
  }
}

function openAiUsageChunk(promptTokens, completionTokens) {
  return {
    id: `chatcmpl_task12_usage_${Date.now()}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "task-12-mock-model",
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
  const parts = []
  for await (const chunk of request) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"))
}

async function waitForJsonOk(url, timeoutMs) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error(`Timed out waiting for server readiness at ${url}.`)
}

function readChildSession(input) {
  const db = new DatabaseSync(input.databasePath)

  try {
    db.exec("PRAGMA foreign_keys = ON")
    const row = db
      .prepare(
        `
          SELECT id, title, parent_session_id AS parentSessionId, created_at AS createdAt, updated_at AS updatedAt
          FROM session
          WHERE parent_session_id = ?
          ORDER BY created_at ASC
        `,
      )
      .get(input.parentSessionId)

    return row ?? null
  } finally {
    db.close()
  }
}

async function exerciseVisibleControls(page, input) {
  const interactions = []

  await clickButton(page, /Switch to light mode|Switch to dark mode/, "theme toggle", interactions)
  await clickButton(page, /Switch to light mode|Switch to dark mode/, "theme toggle restore", interactions)

  await clickButton(page, /Close Sidebar/, "close sidebar", interactions)
  await clickButton(page, /Open Sidebar/, "open sidebar", interactions)
  await clickWorkspaceMenuTrigger(page, "open workspace menu", interactions)
  await clickWorkspaceMenuTrigger(page, "close workspace menu", interactions)

  if (input.parentSessionTitle) {
    await clickButton(page, new RegExp(`^${escapeRegExp(input.parentSessionTitle)}$`), "session item", interactions)
  }

  interactions.push({
    action: "covered",
    label: "New Session",
    reason: "clicked during the primary parent-session creation flow",
  })

  await clickButton(page, /Settings|设置/, "open settings", interactions)
  await clickButton(page, /LLM Settings|LLM 设置/, "open llm settings tab", interactions)
  await clickButton(page, /General|通用/, "return general tab", interactions)

  await clickSelectOption(page, {
    triggerName: /^English$|^中文$/,
    optionName: /^English$/,
    interactionLabel: "language select current option",
    interactions,
  })
  await clickSelectOption(page, {
    triggerName: /^Dark$|^Light$|^深色$|^浅色$/,
    optionName: /^Dark$|^深色$/,
    interactionLabel: "theme select current option",
    interactions,
  })

  await clickButton(page, /Apply General Settings|应用通用设置/, "apply general settings", interactions)
  await page.waitForFunction(
    () => document.body.innerText.includes("Applying") === false && document.body.innerText.includes("应用中") === false,
    null,
    { timeout: 20_000 },
  )
  await clickButton(page, /^Close$|^关闭$/, "close settings", interactions)
  const viewDetailsButton = page.getByRole("button", { name: /View details|查看详情/ }).first()
  if (await viewDetailsButton.isVisible().catch(() => false)) {
    await viewDetailsButton.click()
    await page.waitForTimeout(150)
    interactions.push({ action: "clicked", label: "view details" })
  }
  const hideDetailsButton = page.getByRole("button", { name: /Hide details|隐藏详情/ }).first()
  if (await hideDetailsButton.isVisible().catch(() => false)) {
    await hideDetailsButton.click()
    await page.waitForTimeout(150)
    interactions.push({ action: "clicked", label: "hide details" })
    const reopenedDetailsButton = page.getByRole("button", { name: /View details|查看详情/ }).first()
    if (await reopenedDetailsButton.isVisible().catch(() => false)) {
      await reopenedDetailsButton.click()
      await page.waitForTimeout(150)
      interactions.push({ action: "clicked", label: "view details reopen" })
    }
  }

  const finalWorkspaceTrigger = await assignWorkspaceMenuTriggerId(page)
  if (finalWorkspaceTrigger) {
    await page.locator(`button[data-task12-button-id="${finalWorkspaceTrigger}"]`).click()
    await page.waitForTimeout(150)
    interactions.push({ action: "clicked", label: "final workspace menu toggle" })
    await page.locator(`button[data-task12-button-id="${finalWorkspaceTrigger}"]`).click()
    await page.waitForTimeout(150)
    interactions.push({ action: "clicked", label: "final workspace menu restore" })
  }

  const remainingButtons = await collectVisibleEnabledButtons(page)
  const skipped = []

  for (const button of remainingButtons) {
    const normalized = normalizeLabel(button.label)
    if (normalized.includes("new workspace") || normalized.includes("新建工作区")) {
      skipped.push({
        action: "skipped",
        label: button.label,
        reason: "native directory dialog is intentionally out of scope for this deterministic verifier",
      })
      continue
    }

    if (normalized === "new session") {
      continue
    }

    if (normalized === normalizeLabel(input.parentSessionTitle ?? "")) {
      continue
    }

    if (normalized === "workspace") {
      continue
    }

    if (normalized.includes("settings") || normalized.includes("设置")) {
      continue
    }

    if (normalized.includes("switch to light mode") || normalized.includes("switch to dark mode")) {
      continue
    }

    if (normalized.includes("close sidebar") || normalized.includes("open sidebar")) {
      continue
    }

    if (normalized === "close" || normalized === "关闭") {
      continue
    }

    if (normalized.includes("apply general settings") || normalized.includes("应用通用设置")) {
      continue
    }

    if (normalized.includes("hide details") || normalized.includes("隐藏详情")) {
      continue
    }

    if (normalized.includes("view details") || normalized.includes("查看详情")) {
      continue
    }

    skipped.push({
      action: "skipped",
      label: button.label,
      reason: "button remained visible after the curated sweep and needs an explicit task-specific interaction strategy",
    })
  }

  return {
    clicked: interactions.filter((interaction) => interaction.action === "clicked"),
    covered: interactions.filter((interaction) => interaction.action === "covered"),
    skipped,
    interactions: [...interactions, ...skipped],
  }
}

async function clickButton(page, name, interactionLabel, interactions) {
  const button = page.getByRole("button", { name }).first()
  await button.waitFor({ timeout: 20_000 })
  await button.click()
  await page.waitForTimeout(150)
  interactions.push({ action: "clicked", label: interactionLabel })
}

async function clickSelectOption(page, input) {
  const triggerId = await assignVisibleButtonId(page, {
    labelPattern: input.triggerName,
    index: input.triggerIndex ?? 0,
  })
  const trigger = page.locator(`button[data-task12-button-id="${triggerId}"]`)
  await trigger.waitFor({ timeout: 20_000 })
  await trigger.click()
  await page.waitForTimeout(150)
  input.interactions.push({ action: "clicked", label: `${input.interactionLabel} trigger` })
  const option = page.getByRole("option", { name: input.optionName }).first()
  await option.waitFor({ timeout: 20_000 })
  await option.click()
  await page.waitForTimeout(150)
  input.interactions.push({ action: "clicked", label: input.interactionLabel })
}

async function clickWorkspaceMenuTrigger(page, interactionLabel, interactions) {
  const triggerId = await assignWorkspaceMenuTriggerId(page)

  assert(triggerId, "Could not locate the visible workspace menu trigger.")
  const trigger = page.locator(`button[data-task12-button-id="${triggerId}"]`)
  await trigger.waitFor({ timeout: 20_000 })
  await trigger.click()
  await page.waitForTimeout(150)
  interactions.push({ action: "clicked", label: interactionLabel })
}

async function assignWorkspaceMenuTriggerId(page) {
  return await page.evaluate(() => {
    for (const [index, button] of Array.from(document.querySelectorAll("button")).entries()) {
      const style = window.getComputedStyle(button)
      const rect = button.getBoundingClientRect()
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        Number.parseFloat(style.opacity || "1") > 0.05
      const label = button.innerText.replace(/\s+/gu, " ").trim()
      const hasPopup = button.getAttribute("aria-haspopup") === "listbox"

      if (!visible || !hasPopup || label !== "workspace") {
        continue
      }

      const id = `task12-workspace-trigger-${index}`
      button.setAttribute("data-task12-button-id", id)
      return id
    }

    return null
  })
}

async function assignVisibleButtonId(page, input) {
  const buttonId = await page.evaluate(({ source, flags, index }) => {
    const pattern = new RegExp(source, flags)
    let matched = 0

    for (const [buttonIndex, button] of Array.from(document.querySelectorAll("button")).entries()) {
      const style = window.getComputedStyle(button)
      const rect = button.getBoundingClientRect()
      const label =
        button.getAttribute("aria-label")?.trim() ||
        button.getAttribute("title")?.trim() ||
        button.innerText.replace(/\s+/gu, " ").trim()

      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        Number.parseFloat(style.opacity || "1") > 0.05

      if (!visible || !label || !pattern.test(label)) {
        continue
      }

      if (matched !== index) {
        matched += 1
        continue
      }

      const nextId = `task12-visible-button-${buttonIndex}`
      button.setAttribute("data-task12-button-id", nextId)
      return nextId
    }

    return null
  }, {
    source: input.labelPattern.source,
    flags: input.labelPattern.flags,
    index: input.index,
  })

  assert(buttonId, `Could not locate visible button for ${String(input.labelPattern)} at index ${input.index}.`)
  return buttonId
}

async function collectVisibleEnabledButtons(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button"))
      .map((button) => {
        const style = window.getComputedStyle(button)
        const rect = button.getBoundingClientRect()
        const label =
          button.getAttribute("aria-label")?.trim() ||
          button.getAttribute("title")?.trim() ||
          button.innerText.replace(/\s+/gu, " ").trim()

        return {
          label,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.pointerEvents !== "none" &&
            Number.parseFloat(style.opacity || "1") > 0.05,
          enabled: !button.disabled && button.getAttribute("aria-disabled") !== "true",
        }
      })
      .filter((button) => button.visible && button.enabled && button.label)
  })
}

function unwrapSessions(response, label) {
  assert(response?.ok, `${label} failed with status ${response?.status ?? "unknown"}.`)
  const sessions = response.body?.data?.sessions
  assert(Array.isArray(sessions), `${label} did not return a sessions array.`)
  return sessions
}

function unwrapTimeline(response, label) {
  assert(response?.ok, `${label} failed with status ${response?.status ?? "unknown"}.`)
  const timeline = response.body?.data?.timeline
  assert(Array.isArray(timeline), `${label} did not return a timeline array.`)
  return timeline
}

function hasTimelinePart(timeline, kind, toolName) {
  return timeline.some((message) =>
    (message.parts ?? []).some(
      (part) => part.kind === kind && (part.data?.toolName ?? null) === toolName,
    ),
  )
}

function readTimelineVisibleText(timeline) {
  return timeline
    .flatMap((message) =>
      (message.parts ?? []).flatMap((part) => {
        if ((part.kind === "text" || part.kind === "tool_result") && typeof part.text === "string") {
          return [part.text]
        }

        return []
      }),
    )
    .join("\n")
}

function extractMessageContent(message) {
  if (!message) {
    return null
  }

  if (typeof message.content === "string") {
    return message.content
  }

  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text ?? "").join("\n")
  }

  return null
}

function formatProcessLogs(stdoutChunks, stderrChunks) {
  const stdout = stdoutChunks.join("").trim()
  const stderr = stderrChunks.join("").trim()
  return [stdout ? `STDOUT:\n${stdout}` : "", stderr ? `STDERR:\n${stderr}` : ""]
    .filter(Boolean)
    .join("\n\n")
}

function normalizeLabel(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return
  }

  child.kill("SIGTERM")
  await new Promise((resolve) => setTimeout(resolve, 250))

  if (child.exitCode === null && !child.killed) {
    child.kill("SIGKILL")
  }
}

async function stopHttpServer(server) {
  if (!server) {
    return
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve(undefined)
    })
  })
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
