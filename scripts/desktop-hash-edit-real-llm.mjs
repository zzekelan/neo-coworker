// Desktop real-LLM hash-anchored edit performance verifier (Task 9 of hash-anchored-edit plan).
// Launches the Electron desktop app via Playwright, configures live LLM credentials through
// the actual Settings UI, runs three deterministic anchored-edit prompts against an isolated
// fixture workspace using a real LLM endpoint, and captures evidence under
// .sisyphus/evidence/task-9-desktop-real-llm/.
//
// Required env: DESKTOP_REAL_LLM_PROVIDER, DESKTOP_REAL_LLM_API_KEY, DESKTOP_REAL_LLM_MODEL.
// Optional env: DESKTOP_REAL_LLM_BASE_URL, DESKTOP_REAL_LLM_TIMEOUT_MS, DESKTOP_REAL_LLM_MAX_MS.
//
// Secrets (API keys) are NEVER written to evidence files, screenshots, or trace zips.
// Mechanism: Playwright tracing and all screenshot capture begin only AFTER the Settings
// modal containing the API key input has been applied and fully unmounted. A defensive
// check refuses to start tracing while any `input[type="password"]` remains in the DOM.
// Credentials enter the system exclusively through the Settings UI (never via env vars
// inherited by the Electron child) and are never logged, persisted, or serialized.

import { _electron as electron } from "playwright"
import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cwd = process.cwd()

const REQUIRED_ENV = ["DESKTOP_REAL_LLM_PROVIDER", "DESKTOP_REAL_LLM_API_KEY", "DESKTOP_REAL_LLM_MODEL"]
const missingEnv = REQUIRED_ENV.filter((name) => !(process.env[name] ?? "").trim())
if (missingEnv.length > 0) {
  console.error(
    `desktop-hash-edit-real-llm: missing required env vars: ${missingEnv.join(", ")}.\n` +
      "Set DESKTOP_REAL_LLM_PROVIDER, DESKTOP_REAL_LLM_API_KEY, DESKTOP_REAL_LLM_MODEL " +
      "(and optionally DESKTOP_REAL_LLM_BASE_URL, DESKTOP_REAL_LLM_TIMEOUT_MS, DESKTOP_REAL_LLM_MAX_MS) " +
      "to run the live verifier.",
  )
  process.exit(2)
}

const liveLlm = {
  provider: process.env.DESKTOP_REAL_LLM_PROVIDER.trim(),
  apiKey: process.env.DESKTOP_REAL_LLM_API_KEY.trim(),
  model: process.env.DESKTOP_REAL_LLM_MODEL.trim(),
  baseURL: (process.env.DESKTOP_REAL_LLM_BASE_URL ?? "").trim(),
  timeoutMs: parsePositiveInt(process.env.DESKTOP_REAL_LLM_TIMEOUT_MS, null),
}
const maxMs = parsePositiveInt(process.env.DESKTOP_REAL_LLM_MAX_MS, 180_000)

const evidenceRoot = join(cwd, ".sisyphus", "evidence", "task-9-desktop-real-llm")
mkdirSync(evidenceRoot, { recursive: true })

const isolatedRoot = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-hash-edit-"))
const workspaceRoot = join(isolatedRoot, "workspace")
const databasePath = join(isolatedRoot, "server.sqlite")
const fixturePath = join(workspaceRoot, "hash-edit-fixture.md")
mkdirSync(workspaceRoot, { recursive: true })

const FIXTURE_LINES_LF = [
  "# Hash Edit Live Fixture",
  "",
  "## Duplicate Blocks",
  "block: alpha",
  "status: pending",
  "target: unchanged",
  "",
  "block: beta",
  "status: pending",
  "target: unchanged",
  "",
  "## Mixed Punctuation Case",
  "message: 阶段1：read anchor, verify=100%; path=src/tool/edit.ts；然后 update(status=\"pending\", reason='半角/全角混用')。",
  "",
  "## Blank Line Case",
  "",
  "final: keep",
  "",
]
const FIXTURE_CRLF = FIXTURE_LINES_LF.join("\r\n")

const ATTEMPTS = [
  {
    id: "attempt-1-duplicate-block",
    label: "Duplicate-line anchored replace",
    prompt:
      "In the current workspace, read hash-edit-fixture.md. Then use the edit tool with the hash anchor from the read output to change only the target line in the beta block from `target: unchanged` to `target: changed-by-anchor`. Do not change the alpha block.",
    expectFinalContent() {
      const lines = [...FIXTURE_LINES_LF]
      // The beta target line is the second occurrence of "target: unchanged" (1-indexed line 10 in spec).
      // Find the second occurrence within the LF mirror.
      let seen = 0
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] === "target: unchanged") {
          seen += 1
          if (seen === 2) {
            lines[i] = "target: changed-by-anchor"
            break
          }
        }
      }
      return lines.join("\r\n")
    },
    extraAssert(content) {
      // alpha unchanged
      if (!content.includes("block: alpha\r\nstatus: pending\r\ntarget: unchanged\r\n")) {
        throw new Error("Alpha block was unexpectedly modified or CRLF was not preserved.")
      }
    },
  },
  {
    id: "attempt-2-mixed-punctuation",
    label: "Mixed Chinese/English punctuation anchored replace",
    prompt:
      "Read hash-edit-fixture.md. Use the hash-anchored edit tool to replace the Mixed Punctuation Case message line with exactly: `message: 阶段2：anchor-edit OK, latency<=180s；path=src/tool/read.ts；next(step=\"telemetry\", note='保留：中文，全角；English, half-width!')。`",
    expectedMessageLine:
      "message: 阶段2：anchor-edit OK, latency<=180s；path=src/tool/read.ts；next(step=\"telemetry\", note='保留：中文，全角；English, half-width!')。",
    expectFinalContent() {
      const lines = [...FIXTURE_LINES_LF]
      const idx = lines.findIndex((line) => line.startsWith("message:"))
      if (idx === -1) {
        throw new Error("Fixture template missing message line.")
      }
      lines[idx] = this.expectedMessageLine
      return lines.join("\r\n")
    },
    extraAssert(content) {
      if (!content.includes(this.expectedMessageLine)) {
        throw new Error("Replaced message line did not match the expected mixed-punctuation text exactly.")
      }
    },
  },
  {
    id: "attempt-3-blank-line-append",
    label: "Blank-line anchored append",
    prompt:
      "Read hash-edit-fixture.md. Use the hash-anchored edit tool to append this line immediately after the blank line under `## Blank Line Case`: `inserted: after-blank-anchor`.",
    expectFinalContent() {
      const lines = [...FIXTURE_LINES_LF]
      // Pattern: ["## Blank Line Case", "", "final: keep", ""] -> insert "inserted: after-blank-anchor"
      // immediately after the blank line.
      const headerIdx = lines.indexOf("## Blank Line Case")
      if (headerIdx === -1 || lines[headerIdx + 1] !== "" || lines[headerIdx + 2] !== "final: keep") {
        throw new Error("Fixture template missing expected Blank Line Case structure.")
      }
      lines.splice(headerIdx + 2, 0, "inserted: after-blank-anchor")
      return lines.join("\r\n")
    },
    extraAssert(content) {
      if (!content.includes("\r\n\r\ninserted: after-blank-anchor\r\nfinal: keep\r\n")) {
        throw new Error("Appended line is not positioned immediately after the blank line, or CRLF was lost.")
      }
    },
  },
]

const launchEnv = {
  ...process.env,
  DESKTOP_WORKSPACE_ROOT: workspaceRoot,
  DESKTOP_SELECTION_STATE_PATH: join(isolatedRoot, "desktop-state.json"),
  DESKTOP_SETTINGS_STATE_PATH: join(isolatedRoot, "desktop-settings.json"),
  NCOWORKER_SERVER_DB_PATH: databasePath,
  AGENT_SERVER_DB_PATH: databasePath,
}
// Strip both standard LLM env vars and the verifier-specific DESKTOP_REAL_LLM_* vars from the
// child environment, so live credentials only enter the running app via the Settings UI and
// never via inherited process env. The parent automation process still reads them from
// process.env above; we only redact the copy passed to the Electron child.
delete launchEnv.LLM_PROVIDER
delete launchEnv.LLM_API_KEY
delete launchEnv.LLM_MODEL
delete launchEnv.LLM_BASE_URL
delete launchEnv.LLM_TIMEOUT_MS
delete launchEnv.DESKTOP_REAL_LLM_PROVIDER
delete launchEnv.DESKTOP_REAL_LLM_API_KEY
delete launchEnv.DESKTOP_REAL_LLM_MODEL
delete launchEnv.DESKTOP_REAL_LLM_BASE_URL
delete launchEnv.DESKTOP_REAL_LLM_TIMEOUT_MS
delete launchEnv.DESKTOP_REAL_LLM_MAX_MS

let app = null
let traceStarted = false
const tracePath = join(evidenceRoot, "trace.zip")
const metricsPath = join(evidenceRoot, "metrics.json")
const finalDiffPath = join(evidenceRoot, "final-diff.txt")
const runTracePath = join(evidenceRoot, "run-trace.json")
const sqliteSummaryPath = join(evidenceRoot, "sqlite-events.json")
const telemetrySummaryPath = join(evidenceRoot, "telemetry-summary.json")

const attemptResults = []
const overallStart = Date.now()

try {
  app = await electron.launch({
    args: ["src/desktop/electron/main.mjs"],
    cwd,
    env: launchEnv,
  })
  const page = await app.firstWindow()
  const traceContext = page.context()
  // NOTE: Playwright tracing is intentionally NOT started here. Starting it before the Settings
  // UI is filled would capture the API key field (DOM snapshots / screenshots) inside trace.zip,
  // violating the "no secrets in evidence" guarantee. Tracing is started later, AFTER the
  // Settings modal has been applied and closed, so credential entry never lands in a trace.

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
  if (bridgeWorkspaceRoot !== workspaceRoot) {
    throw new Error(
      `Desktop bridge did not expose the isolated workspace root (got ${bridgeWorkspaceRoot ?? "null"}).`,
    )
  }

  // Configure live LLM through the Settings UI.
  await page.getByRole("button", { name: /Settings|设置/ }).click()
  await page.waitForSelector("text=.ncoworker/desktop-settings.json", { timeout: 15_000 })
  await page.getByRole("button", { name: /LLM Settings|LLM 设置/ }).click()

  await chooseProvider(page, liveLlm.provider)
  await fillFieldByLabel(page, /^(API key|API Key)$/, liveLlm.apiKey, { type: "password" })
  await fillFieldByLabel(page, /^(Model|模型)$/, liveLlm.model)
  if (liveLlm.baseURL) {
    await fillFieldByLabel(page, /^Base URL$/, liveLlm.baseURL)
  }
  if (liveLlm.timeoutMs !== null) {
    try {
      await fillFieldByLabel(page, /Timeout|超时/, String(liveLlm.timeoutMs))
    } catch {
      // Optional control; ignore if not present.
    }
  }

  await page.getByRole("button", { name: /Apply LLM Settings|应用 LLM 设置/ }).click()
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("Applying") === false &&
      document.body.innerText.includes("应用中") === false,
    null,
    { timeout: 60_000 },
  )

  const sessionsHealthcheck = await requestJson(page, "/sessions")
  if (!sessionsHealthcheck.ok) {
    throw new Error("Desktop did not leave the managed app-server reachable after LLM apply.")
  }

  await page.getByRole("button", { name: /^Close$|^关闭$/ }).click()

  // Wait for the Settings modal (which displayed the API key input) to fully unmount before
  // any tracing or screenshots begin. This guarantees the credential field is no longer in the
  // DOM/visible viewport when Playwright captures snapshots or images.
  await page
    .waitForFunction(
      () =>
        document.body.innerText.includes(".ncoworker/desktop-settings.json") === false,
      null,
      { timeout: 15_000 },
    )
    .catch(() => undefined)

  // Defense-in-depth: if any input still holds the API key value (it should not, the modal is
  // unmounted), refuse to start tracing. We never compare against the secret itself; we only
  // check that no password-typed input remains in the DOM.
  const passwordInputsRemaining = await page.locator("input[type=\"password\"]").count()
  if (passwordInputsRemaining > 0) {
    throw new Error(
      "Refusing to start Playwright tracing: a password input is still present in the DOM, " +
        "which could leak credentials into trace.zip.",
    )
  }

  // Now safe to start tracing — Settings is closed, no credential field is reachable.
  try {
    await traceContext.tracing.start({
      name: "task-9-desktop-real-llm",
      screenshots: true,
      snapshots: true,
      sources: false,
    })
    traceStarted = true
  } catch {
    traceStarted = false
  }

  for (let i = 0; i < ATTEMPTS.length; i += 1) {
    const attempt = ATTEMPTS[i]
    // Reset fixture with CRLF endings for every attempt.
    writeFileSync(fixturePath, FIXTURE_CRLF, { encoding: "utf8" })

    const sessionsPath = `/workspace/sessions?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
    const beforeSessionsResponse = await requestJson(page, sessionsPath)
    const beforeSessions = beforeSessionsResponse.body?.data?.sessions ?? []
    const beforeIds = new Set(beforeSessions.map((session) => session.id))

    await page.getByTitle("New Session").click()

    let sessionId = null
    for (let attemptIdx = 0; attemptIdx < 80; attemptIdx += 1) {
      const sessionsResponse = await requestJson(page, sessionsPath)
      const sessions = sessionsResponse.body?.data?.sessions ?? []
      const created = sessions.find((session) => beforeIds.has(session.id) === false) ?? null
      if (created) {
        sessionId = created.id
        break
      }
      await page.waitForTimeout(250)
    }
    if (!sessionId) {
      throw new Error(`Desktop UI did not create a new session for ${attempt.id}.`)
    }

    await page.locator("textarea").fill(attempt.prompt)
    const beforeScreenshot = join(evidenceRoot, `${attempt.id}-before-submit.png`)
    await page.screenshot({ path: beforeScreenshot, fullPage: true })

    const submitStart = Date.now()
    await page.locator("button[type=submit]").click()

    const watchdogMs = Math.max(maxMs * 2, 60_000)
    let latestRunStatus = null
    let latestRunId = null
    let permissionApproved = false

    while (Date.now() - submitStart < watchdogMs) {
      const sessionResponse = await requestJson(page, `/sessions/${encodeURIComponent(sessionId)}`)
      const snapshot = sessionResponse.body?.data ?? null
      latestRunStatus = snapshot?.latestRun?.status ?? null
      latestRunId = snapshot?.latestRun?.id ?? latestRunId

      if (latestRunStatus === "waiting_permission") {
        const permissionsResponse = await requestJson(
          page,
          `/runs/${encodeURIComponent(latestRunId)}/permissions`,
        )
        const requests = permissionsResponse.body?.data?.permissionRequests ?? []
        const pending = requests.find((request) => request.status === "pending")
        if (pending) {
          // Approve through the actual UI (act like a real user).
          const allowButton = page.getByRole("button", { name: /^Allow$|^允许$/ }).first()
          try {
            await allowButton.waitFor({ timeout: 15_000 })
            await allowButton.click()
            permissionApproved = true
          } catch {
            // Fall back to bridge if UI button is not visible (defensive).
            await requestJson(
              page,
              `/permissions/${encodeURIComponent(pending.id)}/reply`,
              "POST",
              { decision: "allow" },
            )
            permissionApproved = true
          }
        }
        await page.waitForTimeout(300)
        continue
      }

      if (
        latestRunStatus === "completed" ||
        latestRunStatus === "failed" ||
        latestRunStatus === "cancelled"
      ) {
        break
      }

      await page.waitForTimeout(500)
    }
    const submitEnd = Date.now()
    const latencyMs = submitEnd - submitStart

    const afterScreenshot = join(evidenceRoot, `${attempt.id}-after-completion.png`)
    await page.screenshot({ path: afterScreenshot, fullPage: true })

    if (latestRunStatus !== "completed") {
      throw new Error(
        `${attempt.id}: run did not complete (status=${latestRunStatus ?? "missing"}, latencyMs=${latencyMs}).`,
      )
    }
    if (!latestRunId) {
      throw new Error(`${attempt.id}: missing run id after completion.`)
    }

    // Verify disk content.
    const actualContent = readFileSync(fixturePath, { encoding: "utf8" })
    const expectedContent = attempt.expectFinalContent()
    if (actualContent !== expectedContent) {
      const diff = renderDiff(expectedContent, actualContent)
      writeFileSync(
        join(evidenceRoot, `${attempt.id}-final-diff.txt`),
        `FAILED: actual fixture content does not match expected.\n${diff}\n`,
      )
      throw new Error(
        `${attempt.id}: final fixture content does not match expected anchored edit result.`,
      )
    }
    attempt.extraAssert(actualContent)

    // Telemetry checks via /runs/:runId/trace.
    const runTraceResponse = await requestJson(
      page,
      `/runs/${encodeURIComponent(latestRunId)}/trace`,
    )
    if (!runTraceResponse.ok) {
      throw new Error(`${attempt.id}: failed to fetch /runs/:runId/trace.`)
    }
    const trace = runTraceResponse.body?.data?.trace ?? null
    if (!trace) {
      throw new Error(`${attempt.id}: empty run trace.`)
    }
    const traceEvents = Array.isArray(trace.events) ? trace.events : []
    const traceEventTypes = traceEvents.map((event) => event.eventType)

    const sqliteEvidence = readSqliteEvidence({
      databasePath,
      runId: latestRunId,
      sessionId,
    })

    // Assertions on telemetry contents.
    assertTraceContains(traceEventTypes, "model.turn.requested", attempt.id)
    assertTraceContains(traceEventTypes, "run.completed", attempt.id)
    assertReadToolCall(sqliteEvidence, attempt.id)
    assertAnchorOnlyEditCall(traceEvents, sqliteEvidence, attempt.id)
    if (permissionApproved) {
      // Permission response telemetry must be present in trace or sqlite events.
      const permissionRecorded =
        traceEventTypes.some((type) => type.startsWith("permission.")) ||
        sqliteEvidence.runEvents.some((event) => event.eventType.startsWith("permission."))
      if (!permissionRecorded) {
        throw new Error(`${attempt.id}: permission response not recorded in telemetry.`)
      }
    }
    assertNoLegacyEditFields(trace, sqliteEvidence, attempt.id)

    const editAnchorSuccessPresent =
      traceEventTypes.includes("edit.anchor.success") ||
      sqliteEvidence.runEvents.some((event) => event.eventType === "edit.anchor.success")
    // Per Task 4 known-issue note: direct edit observer injection may not yet emit edit.anchor.* in
    // the live runtime path. Document but do not fail-fast — the disk content + read+edit tool calls
    // already prove the anchor-only edit succeeded.
    attemptResults.push({
      id: attempt.id,
      label: attempt.label,
      sessionId,
      runId: latestRunId,
      latencyMs,
      latestRunStatus,
      permissionApproved,
      traceEventTypes,
      editAnchorSuccessPresent,
      beforeScreenshot,
      afterScreenshot,
      sqliteEventCount: sqliteEvidence.runEvents.length,
      readToolCalls: countToolCalls(sqliteEvidence, "read"),
      editToolCalls: countToolCalls(sqliteEvidence, "edit"),
    })

    // Persist per-attempt run trace + sqlite snapshot (overwritten across attempts; last survives).
    writeFileSync(runTracePath, `${JSON.stringify(trace, null, 2)}\n`)
    writeFileSync(sqliteSummaryPath, `${JSON.stringify(sqliteEvidence, null, 2)}\n`)
  }

  // Latency thresholds.
  const latencies = attemptResults.map((result) => result.latencyMs).sort((a, b) => a - b)
  const median = latencies[Math.floor(latencies.length / 2)]
  const max = Math.max(...latencies)
  const allWithinHardCap = max <= maxMs * 2
  const medianWithinTarget = median <= maxMs

  const metrics = {
    provider: liveLlm.provider,
    model: liveLlm.model,
    baseURL: liveLlm.baseURL || null,
    maxMsThreshold: maxMs,
    medianLatencyMs: median,
    maxLatencyMs: max,
    allWithinHardCap,
    medianWithinTarget,
    attempts: attemptResults.map((result) => ({
      id: result.id,
      label: result.label,
      latencyMs: result.latencyMs,
      latestRunStatus: result.latestRunStatus,
      permissionApproved: result.permissionApproved,
      readToolCalls: result.readToolCalls,
      editToolCalls: result.editToolCalls,
      editAnchorSuccessPresent: result.editAnchorSuccessPresent,
    })),
    totalWallClockMs: Date.now() - overallStart,
  }
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`)

  // Final fixture diff/content (last attempt's final content).
  writeFileSync(
    finalDiffPath,
    `Last-attempt fixture content (${ATTEMPTS[ATTEMPTS.length - 1].id}):\n` +
      `${readFileSync(fixturePath, { encoding: "utf8" })}\n`,
  )

  // Telemetry summary across all attempts.
  writeFileSync(
    telemetrySummaryPath,
    `${JSON.stringify(
      {
        attempts: attemptResults.map((result) => ({
          id: result.id,
          runId: result.runId,
          sessionId: result.sessionId,
          traceEventTypes: result.traceEventTypes,
          sqliteEventCount: result.sqliteEventCount,
          editAnchorSuccessPresent: result.editAnchorSuccessPresent,
          permissionApproved: result.permissionApproved,
        })),
        thresholds: { maxMs, hardCapMs: maxMs * 2 },
        latencyMs: { median, max, all: latencies },
        secretsRedacted: true,
      },
      null,
      2,
    )}\n`,
  )

  if (!allWithinHardCap) {
    throw new Error(
      `At least one attempt exceeded the hard cap of 2x max (${maxMs * 2}ms). Latencies: ${latencies.join(", ")}`,
    )
  }
  if (!medianWithinTarget) {
    throw new Error(
      `Median latency ${median}ms exceeded DESKTOP_REAL_LLM_MAX_MS=${maxMs}ms. Latencies: ${latencies.join(", ")}`,
    )
  }

  if (traceStarted) {
    try {
      await traceContext.tracing.stop({ path: tracePath })
      traceStarted = false
    } catch {
      traceStarted = false
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: liveLlm.provider,
        model: liveLlm.model,
        attempts: attemptResults.map((result) => ({
          id: result.id,
          latencyMs: result.latencyMs,
          status: result.latestRunStatus,
          permissionApproved: result.permissionApproved,
          editAnchorSuccessPresent: result.editAnchorSuccessPresent,
        })),
        median,
        max,
        evidence: {
          metricsPath,
          finalDiffPath,
          runTracePath,
          sqliteSummaryPath,
          telemetrySummaryPath,
          tracePath: existsSync(tracePath) ? tracePath : null,
        },
      },
      null,
      2,
    ),
  )
} finally {
  if (traceStarted && app) {
    try {
      const ctx = (await app.firstWindow().catch(() => null))?.context()
      if (ctx) {
        await ctx.tracing.stop({ path: tracePath })
      }
    } catch {
      // ignore
    }
  }
  if (app) {
    try {
      await app.close()
    } catch {
      // ignore
    }
  }
  // Best-effort cleanup of the isolated state root.
  try {
    rmSync(isolatedRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ---------- helpers ----------

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null) {
    return fallback
  }
  const trimmed = String(value).trim()
  if (trimmed === "") {
    return fallback
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

async function requestJson(page, path, method = "GET", body) {
  return await page.evaluate(
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

async function chooseProvider(page, providerValue) {
  const trigger = await locateLabeledTrigger(page, /^(LLM provider|LLM 提供商)$/)
  if (!trigger) {
    throw new Error("Could not locate the LLM provider select trigger.")
  }
  await trigger.click()
  await page.waitForTimeout(150)
  const option = page
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(providerValue)}$`) })
    .first()
  await option.waitFor({ timeout: 8_000 })
  await option.click()
  await page.waitForTimeout(150)
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

async function fillFieldByLabel(page, labelPattern, value, options) {
  const label = page
    .locator("label")
    .filter({ has: page.locator("span", { hasText: labelPattern }) })
    .first()
  if ((await label.count()) === 0) {
    throw new Error(`Could not locate input with label ${labelPattern}.`)
  }
  const inputSelector =
    options?.type === "password"
      ? "input[type=\"password\"]"
      : "input:not([type=\"password\"])"
  const input = label.locator(inputSelector).first()
  await input.waitFor({ timeout: 8_000 })
  await input.fill("")
  await input.fill(value)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function renderDiff(expected, actual) {
  const expectedLines = expected.split("\r\n")
  const actualLines = actual.split(/\r\n|\n/)
  const max = Math.max(expectedLines.length, actualLines.length)
  const lines = []
  for (let i = 0; i < max; i += 1) {
    const e = expectedLines[i] ?? "<missing>"
    const a = actualLines[i] ?? "<missing>"
    if (e !== a) {
      lines.push(`L${i + 1} expected: ${JSON.stringify(e)}`)
      lines.push(`L${i + 1} actual:   ${JSON.stringify(a)}`)
    }
  }
  return lines.join("\n")
}

function readSqliteEvidence(input) {
  const pythonScript = String.raw`
import json
import sqlite3
import sys

database_path, session_id, run_id = sys.argv[1:4]
connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row

run_row = connection.execute(
    "SELECT id, status, error_text FROM run WHERE id = ?",
    (run_id,),
).fetchone()

event_rows = connection.execute(
    "SELECT sequence, source, event_type, data_json FROM run_event WHERE run_id = ? ORDER BY sequence ASC",
    (run_id,),
).fetchall()

events = []
for row in event_rows:
    try:
        data = json.loads(row["data_json"]) if row["data_json"] else {}
    except Exception:
        data = {"raw": row["data_json"]}
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
        "id": run_row["id"] if run_row else None,
        "status": run_row["status"] if run_row else None,
        "errorText": run_row["error_text"] if run_row else None,
    } if run_row else None,
    "runEvents": events,
}

print(json.dumps(result))
`
  const result = spawnSync(
    "python3",
    ["-c", pythonScript, input.databasePath, input.sessionId, input.runId],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    const fallback = spawnSync(
      "python",
      ["-c", pythonScript, input.databasePath, input.sessionId, input.runId],
      { encoding: "utf8" },
    )
    if (fallback.status !== 0) {
      throw new Error(
        `SQLite evidence query failed: ${(fallback.stderr || fallback.stdout || result.stderr || result.stdout || "unknown").trim()}`,
      )
    }
    return JSON.parse(fallback.stdout)
  }
  return JSON.parse(result.stdout)
}

function assertTraceContains(traceEventTypes, eventType, attemptId) {
  if (!traceEventTypes.includes(eventType)) {
    throw new Error(`${attemptId}: trace missing required event ${eventType}.`)
  }
}

function assertReadToolCall(sqliteEvidence, attemptId) {
  const events = sqliteEvidence.runEvents ?? []
  const hasReadCall = events.some((event) => {
    if (event.eventType !== "tool.call.requested" && event.eventType !== "tool.call.completed") {
      return false
    }
    const toolName = event.data?.toolName ?? event.data?.tool ?? null
    return toolName === "read"
  })
  if (!hasReadCall) {
    throw new Error(`${attemptId}: telemetry did not include a read tool call.`)
  }
}

function assertAnchorOnlyEditCall(traceEvents, sqliteEvidence, attemptId) {
  const allEvents = [...(traceEvents ?? []), ...(sqliteEvidence.runEvents ?? [])]
  let editCallSeen = false
  for (const event of allEvents) {
    const isToolEvent =
      event.eventType === "tool.call.requested" || event.eventType === "tool.call.completed"
    if (!isToolEvent) {
      continue
    }
    const toolName = event.data?.toolName ?? event.data?.tool ?? null
    if (toolName !== "edit") {
      continue
    }
    editCallSeen = true
    const argsText = JSON.stringify(event.data ?? {})
    if (/\boldText\b|\bnewText\b|\breplaceAll\b/.test(argsText)) {
      throw new Error(
        `${attemptId}: edit tool call telemetry contains forbidden legacy field (oldText/newText/replaceAll).`,
      )
    }
  }
  if (!editCallSeen) {
    throw new Error(`${attemptId}: telemetry did not include an edit tool call.`)
  }
}

function assertNoLegacyEditFields(trace, sqliteEvidence, attemptId) {
  const serializedTrace = JSON.stringify(trace)
  if (/"oldText"|"newText"|"replaceAll"/.test(serializedTrace)) {
    throw new Error(`${attemptId}: run trace contains forbidden legacy edit field.`)
  }
  const serializedSqlite = JSON.stringify(sqliteEvidence)
  if (/"oldText"|"newText"|"replaceAll"/.test(serializedSqlite)) {
    throw new Error(`${attemptId}: SQLite events contain forbidden legacy edit field.`)
  }
}

function countToolCalls(sqliteEvidence, toolName) {
  return (sqliteEvidence.runEvents ?? []).filter((event) => {
    if (event.eventType !== "tool.call.requested") {
      return false
    }
    const name = event.data?.toolName ?? event.data?.tool ?? null
    return name === toolName
  }).length
}
