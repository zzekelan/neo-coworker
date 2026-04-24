// Desktop real-LLM hash-anchored edit performance verifier (Task 9 of hash-anchored-edit plan).
// Launches the Electron desktop app via Playwright, configures live LLM credentials through
// the actual Settings UI, runs three deterministic anchored-edit prompts against an isolated
// fixture workspace using a real LLM endpoint, and captures evidence under
// .sisyphus/evidence/task-9-desktop-real-llm/.
//
// Required env: DESKTOP_REAL_LLM_PROVIDER, DESKTOP_REAL_LLM_API_KEY, DESKTOP_REAL_LLM_MODEL,
// or root .env/.env.local fallbacks named LLM_PROVIDER, LLM_API_KEY, LLM_MODEL.
// Optional env: DESKTOP_REAL_LLM_BASE_URL, DESKTOP_REAL_LLM_TIMEOUT_MS, DESKTOP_REAL_LLM_MAX_MS,
// with .env/.env.local fallbacks named LLM_BASE_URL and LLM_TIMEOUT_MS.
//
// Secrets (API keys) are stored only in the isolated per-run desktop settings state for this
// verifier run and are excluded from evidence files, screenshots, trace zips, and logs.
// Mechanism: Playwright tracing and all screenshot capture begin only AFTER the Settings
// modal has applied credentials, the password field has been cleared, the panel has closed,
// and a defensive guard verifies every remaining `input[type="password"]` has an empty DOM
// value. Credentials are loaded by this parent automation process only to type into Settings
// UI; they are never inherited by the Electron child.

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

const DESKTOP_ENV_FALLBACKS = {
  DESKTOP_REAL_LLM_PROVIDER: "LLM_PROVIDER",
  DESKTOP_REAL_LLM_API_KEY: "LLM_API_KEY",
  DESKTOP_REAL_LLM_MODEL: "LLM_MODEL",
  DESKTOP_REAL_LLM_BASE_URL: "LLM_BASE_URL",
  DESKTOP_REAL_LLM_TIMEOUT_MS: "LLM_TIMEOUT_MS",
}
const VERIFIER_DOTENV_KEYS = new Set(Object.values(DESKTOP_ENV_FALLBACKS))
const dotenvEnv = readVerifierEnvFiles(cwd)
const liveEnv = resolveLiveLlmEnv(process.env, dotenvEnv)

const REQUIRED_ENV = ["DESKTOP_REAL_LLM_PROVIDER", "DESKTOP_REAL_LLM_API_KEY", "DESKTOP_REAL_LLM_MODEL"]
const missingEnv = REQUIRED_ENV.filter((name) => !liveEnv[name])
if (missingEnv.length > 0) {
  console.error(
    `desktop-hash-edit-real-llm: missing required env vars: ${missingEnv.join(", ")}.\n` +
      "Set DESKTOP_REAL_LLM_PROVIDER, DESKTOP_REAL_LLM_API_KEY, DESKTOP_REAL_LLM_MODEL " +
      "or provide LLM_PROVIDER, LLM_API_KEY, LLM_MODEL in root .env/.env.local " +
      "(optionally DESKTOP_REAL_LLM_BASE_URL/LLM_BASE_URL, " +
      "DESKTOP_REAL_LLM_TIMEOUT_MS/LLM_TIMEOUT_MS, DESKTOP_REAL_LLM_MAX_MS) " +
      "to run the live verifier.",
  )
  process.exit(2)
}

const liveLlm = {
  provider: liveEnv.DESKTOP_REAL_LLM_PROVIDER,
  apiKey: liveEnv.DESKTOP_REAL_LLM_API_KEY,
  model: liveEnv.DESKTOP_REAL_LLM_MODEL,
  baseURL: liveEnv.DESKTOP_REAL_LLM_BASE_URL,
  timeoutMs: parsePositiveInt(liveEnv.DESKTOP_REAL_LLM_TIMEOUT_MS, null),
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
      "In the current workspace, read hash-edit-fixture.md. Then call the edit tool to change only the target line in the beta block from `target: unchanged` to `target: changed-by-anchor`. Do not change the alpha block.\n\n" +
      "Edit-tool argument rules: copy `start` and `end` from the read output as the prefix `L{line}#{hash}` only — do NOT include the `|` separator or the trailing line text. Put the new line text in `content` exactly, with no surrounding quotes.",
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
const handledPermissionRequestIds = new Set()
const permissionApprovalEvents = []
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

  await clearPasswordFields(page)
  await page.getByRole("button", { name: /^Close$|^关闭$/ }).click()

  // SettingsPanel stays mounted after close (aria-hidden + opacity), so wait for the hidden
  // state instead of requiring unmount. Tracing/screenshots are still delayed until after the
  // credential field has been cleared and the panel is closed.
  await waitForSettingsPanelClosed(page)

  // Defense-in-depth: hidden password inputs are allowed only when their current DOM values are
  // empty. Never compare against or return the secret; fail on any non-empty password value.
  await assertNoPasswordInputValues(page)

  // Now safe to start tracing — Settings is closed and remaining password fields are empty.
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
    let pollingError = null

    while (Date.now() - submitStart < watchdogMs) {
      try {
        const sessionResponse = await requestJson(page, `/sessions/${encodeURIComponent(sessionId)}`)
        const snapshot = sessionResponse.body?.data ?? null
        latestRunStatus = snapshot?.latestRun?.status ?? null
        latestRunId = snapshot?.latestRun?.id ?? latestRunId

        if (latestRunId) {
          const approvedNow = await approvePendingPermissionIfAny(page, latestRunId)
          permissionApproved = permissionApproved || approvedNow
          if (approvedNow) {
            await sleep(300)
            continue
          }
        }
      } catch (error) {
        pollingError = formatSafeDiagnosticError(error)
        break
      }

      if (
        latestRunStatus === "completed" ||
        latestRunStatus === "failed" ||
        latestRunStatus === "cancelled"
      ) {
        break
      }

      await sleep(500)
    }
    const submitEnd = Date.now()
    const latencyMs = submitEnd - submitStart

    let afterScreenshot = join(evidenceRoot, `${attempt.id}-after-completion.png`)
    let afterScreenshotError = null
    try {
      await page.screenshot({ path: afterScreenshot, fullPage: true })
    } catch (error) {
      afterScreenshotError = formatSafeDiagnosticError(error)
      afterScreenshot = null
      if (latestRunStatus === "completed") {
        throw error
      }
    }

    if (latestRunStatus !== "completed") {
      const failureDiagnostics = latestRunId
        ? await captureFailureDiagnostics({
          page,
          attempt,
          databasePath,
          runId: latestRunId,
          sessionId,
          terminalStatus: latestRunStatus,
          latencyMs,
          permissionApproved,
          pollingError,
          afterScreenshotError,
        })
        : null
      const summarySuffix = failureDiagnostics
        ? ` Failure summary: ${failureDiagnostics.summaryPath}`
        : ""
      throw new Error(
        `${attempt.id}: run did not complete (status=${latestRunStatus ?? "missing"}, latencyMs=${latencyMs}).${summarySuffix}`,
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
      // Also persist the raw actual/expected bytes side-by-side so a human can run
      // `diff -u` / `xxd` for byte-level inspection. The fixture is non-secret test
      // data (markdown about anchored edits), so writing it is safe.
      writeFileSync(join(evidenceRoot, `${attempt.id}-final-actual.bin`), actualContent, { encoding: "utf8" })
      writeFileSync(join(evidenceRoot, `${attempt.id}-final-expected.bin`), expectedContent, { encoding: "utf8" })
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
    if (!editAnchorSuccessPresent) {
      throw new Error(`${attempt.id}: telemetry missing required edit.anchor.success event.`)
    }
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

function readVerifierEnvFiles(root) {
  const env = {}

  for (const fileName of [".env", ".env.local"]) {
    try {
      mergeVerifierEnv(env, readFileSync(join(root, fileName), "utf8"))
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : null
      if (code !== "ENOENT") {
        throw error
      }
    }
  }

  return env
}

function mergeVerifierEnv(target, raw) {
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseVerifierEnvLine(line)
    if (!entry) {
      continue
    }

    target[entry.key] = entry.value
  }
}

function parseVerifierEnvLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) {
    return null
  }

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) {
    return null
  }

  const [, key, rawValue] = match
  if (!VERIFIER_DOTENV_KEYS.has(key)) {
    return null
  }

  return {
    key,
    value: normalizeVerifierEnvValue(rawValue),
  }
}

function normalizeVerifierEnvValue(value) {
  const trimmed = value.trim()

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  const commentIndex = trimmed.search(/\s+#/)
  if (commentIndex === -1) {
    return trimmed
  }

  return trimmed.slice(0, commentIndex).trim()
}

function resolveLiveLlmEnv(environment, dotenvValues) {
  const resolved = {}

  for (const [desktopKey, dotenvKey] of Object.entries(DESKTOP_ENV_FALLBACKS)) {
    const explicit = readLiveEnvValue(environment[desktopKey])
    resolved[desktopKey] = explicit ?? readLiveEnvValue(dotenvValues[dotenvKey]) ?? ""
  }

  return resolved
}

function readLiveEnvValue(value) {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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

async function clearPasswordFields(page) {
  const passwordInputs = page.locator("input[type=\"password\"]")
  const count = await passwordInputs.count()
  for (let index = 0; index < count; index += 1) {
    const passwordInput = passwordInputs.nth(index)
    await passwordInput.fill("")
  }
}

async function approvePendingPermissionIfAny(page, latestRunId) {
  if (!latestRunId) {
    return false
  }

  // The app-server exposes permission requests via GET /runs/:runId (returns
  // {data: {run, permissionRequests}}). There is no /runs/:runId/permissions
  // endpoint - querying that path returns 404 and previously caused the
  // verifier to silently never see pending requests.
  const runResponse = await requestJson(
    page,
    `/runs/${encodeURIComponent(latestRunId)}`,
  )
  const requests = runResponse.body?.data?.permissionRequests ?? []
  const pending = requests.find(
    (request) => request.status === "pending" && !handledPermissionRequestIds.has(request.id),
  )
  if (!pending) {
    return false
  }

  if (await clickVisibleAllowButton(page)) {
    handledPermissionRequestIds.add(pending.id)
    permissionApprovalEvents.push({ runId: latestRunId, requestId: pending.id, method: "ui" })
    return true
  }

  const reply = await requestJson(
    page,
    `/permissions/${encodeURIComponent(pending.id)}/reply`,
    "POST",
    { decision: "allow" },
  )
  if (reply.ok === false) {
    return false
  }

  handledPermissionRequestIds.add(pending.id)
  permissionApprovalEvents.push({ runId: latestRunId, requestId: pending.id, method: "api" })
  return true
}

async function clickVisibleAllowButton(page) {
  const allowButtons = page.getByRole("button", { name: /^Allow$|^允许$/ })
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    const count = await allowButtons.count()
    for (let index = 0; index < count; index += 1) {
      const button = allowButtons.nth(index)
      try {
        if (!(await button.isVisible()) || !(await button.isEnabled())) {
          continue
        }
        await button.scrollIntoViewIfNeeded({ timeout: 1_000 }).catch(() => undefined)
        await button.click({ timeout: 2_000 })
        return true
      } catch {
        // Try another matching visible/enabled button, or retry until the short deadline.
      }
    }

    await sleep(100)
  }

  return false
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForSettingsPanelClosed(page) {
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll("[aria-hidden]")).some(
          (element) =>
            element.getAttribute("aria-hidden") === "true" &&
            (element.textContent ?? "").includes(".ncoworker/desktop-settings.json"),
        ),
      null,
      { timeout: 15_000 },
    )
    .catch(() => undefined)
}

async function assertNoPasswordInputValues(page) {
  const nonEmptyPasswordInputCount = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (input) => input instanceof HTMLInputElement && input.value.length > 0,
    ).length,
  )

  if (nonEmptyPasswordInputCount > 0) {
    throw new Error(
      "Refusing to start Playwright tracing: a password input still has a non-empty value, " +
        "which could leak credentials into trace.zip.",
    )
  }
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
  const summary = renderByteLevelSummary(expected, actual)
  const lineDiff = renderLineLevelDiff(expected, actual)
  const charDiff = renderFirstByteDiff(expected, actual)
  return [summary, charDiff, lineDiff].filter(Boolean).join("\n\n")
}

function describeContent(label, value) {
  const bytes = Buffer.byteLength(value, "utf8")
  const codepoints = Array.from(value).length
  const crlf = (value.match(/\r\n/g) ?? []).length
  // Count standalone LFs (LFs not part of a CRLF pair).
  const totalLf = (value.match(/\n/g) ?? []).length
  const standaloneLf = totalLf - crlf
  const standaloneCr = (value.match(/\r(?!\n)/g) ?? []).length
  const endsWithCrlf = value.endsWith("\r\n")
  const endsWithLfOnly = !endsWithCrlf && value.endsWith("\n")
  const endsWithNeither = !endsWithCrlf && !endsWithLfOnly
  return [
    `${label}: bytes=${bytes} codepoints=${codepoints} crlf=${crlf} lf-only=${standaloneLf} cr-only=${standaloneCr} ` +
      `endsWith=${endsWithCrlf ? "CRLF" : endsWithLfOnly ? "LF" : endsWithNeither ? "<none>" : "?"}`,
  ].join("\n")
}

function renderByteLevelSummary(expected, actual) {
  return [describeContent("expected", expected), describeContent("actual  ", actual)].join("\n")
}

function renderFirstByteDiff(expected, actual) {
  const max = Math.max(expected.length, actual.length)
  for (let i = 0; i < max; i += 1) {
    const e = expected.charCodeAt(i)
    const a = actual.charCodeAt(i)
    if (e !== a) {
      const eHex = Number.isNaN(e) ? "<EOF>" : `0x${e.toString(16).padStart(4, "0")}`
      const aHex = Number.isNaN(a) ? "<EOF>" : `0x${a.toString(16).padStart(4, "0")}`
      const eCtx = JSON.stringify(expected.slice(Math.max(0, i - 16), i + 16))
      const aCtx = JSON.stringify(actual.slice(Math.max(0, i - 16), i + 16))
      return [
        `first-diff at codeunit ${i}: expected=${eHex} actual=${aHex}`,
        `  expected ctx: ${eCtx}`,
        `  actual   ctx: ${aCtx}`,
      ].join("\n")
    }
  }
  if (expected.length !== actual.length) {
    return `first-diff: contents identical up to ${Math.min(expected.length, actual.length)} codeunits, then diverge in length (expected=${expected.length} actual=${actual.length}).`
  }
  return ""
}

function splitLinesPreservingEol(text) {
  // Split into lines while preserving each line's trailing EOL marker so the diff
  // surfaces CRLF vs LF differences explicitly.
  const result = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    if (ch === 0x0d /* CR */ && text.charCodeAt(i + 1) === 0x0a /* LF */) {
      result.push({ content: text.slice(start, i), eol: "\r\n" })
      i += 1
      start = i + 1
    } else if (ch === 0x0a /* LF */) {
      result.push({ content: text.slice(start, i), eol: "\n" })
      start = i + 1
    } else if (ch === 0x0d /* lone CR */) {
      result.push({ content: text.slice(start, i), eol: "\r" })
      start = i + 1
    }
  }
  if (start < text.length) {
    result.push({ content: text.slice(start), eol: "" })
  } else if (text.length === 0 || start === text.length) {
    // Last line was terminated; represent the trailing empty "line" only when
    // the text is empty so callers see an explicit empty-content indicator.
    if (text.length === 0) {
      result.push({ content: "", eol: "" })
    }
  }
  return result
}

function describeEol(eol) {
  if (eol === "\r\n") return "CRLF"
  if (eol === "\n") return "LF"
  if (eol === "\r") return "CR"
  if (eol === "") return "<no-eol>"
  return JSON.stringify(eol)
}

function renderLineLevelDiff(expected, actual) {
  const expectedLines = splitLinesPreservingEol(expected)
  const actualLines = splitLinesPreservingEol(actual)
  const max = Math.max(expectedLines.length, actualLines.length)
  const lines = []
  for (let i = 0; i < max; i += 1) {
    const e = expectedLines[i]
    const a = actualLines[i]
    const eContent = e ? e.content : "<missing>"
    const aContent = a ? a.content : "<missing>"
    const eEol = e ? describeEol(e.eol) : "<missing>"
    const aEol = a ? describeEol(a.eol) : "<missing>"
    if (eContent !== aContent || eEol !== aEol) {
      lines.push(
        `L${i + 1} expected: content=${JSON.stringify(eContent)} eol=${eEol}`,
      )
      lines.push(
        `L${i + 1} actual:   content=${JSON.stringify(aContent)} eol=${aEol}`,
      )
    }
  }
  if (lines.length === 0) {
    return "line-diff: no per-line content differences detected (mismatch is byte/EOL only - see byte summary above)."
  }
  return lines.join("\n")
}

async function captureFailureDiagnostics(input) {
  const tracePath = join(evidenceRoot, `${input.attempt.id}-run-trace.json`)
  const sqlitePath = join(evidenceRoot, `${input.attempt.id}-sqlite-events.json`)
  const summaryPath = join(evidenceRoot, `${input.attempt.id}-failure-summary.json`)

  let trace = null
  let traceError = null
  let sqliteEvidence = null
  let sqliteError = null

  try {
    const runTraceResponse = await requestJson(
      input.page,
      `/runs/${encodeURIComponent(input.runId)}/trace`,
    )
    if (!runTraceResponse.ok) {
      throw new Error("/runs/:runId/trace returned ok=false")
    }
    trace = runTraceResponse.body?.data?.trace ?? null
    if (!trace) {
      throw new Error("/runs/:runId/trace returned an empty trace")
    }
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`)
  } catch (error) {
    traceError = formatSafeDiagnosticError(error)
  }

  try {
    sqliteEvidence = readSqliteEvidence({
      databasePath: input.databasePath,
      runId: input.runId,
      sessionId: input.sessionId,
    })
    writeFileSync(sqlitePath, `${JSON.stringify(sqliteEvidence, null, 2)}\n`)
  } catch (error) {
    sqliteError = formatSafeDiagnosticError(error)
  }

  const summary = {
    attemptId: input.attempt.id,
    label: input.attempt.label,
    sessionId: input.sessionId,
    runId: input.runId,
    terminalStatus: input.terminalStatus ?? "missing",
    latencyMs: input.latencyMs,
    permissionApproved: Boolean(input.permissionApproved),
    permissionApprovalEvents: permissionApprovalEvents.filter((event) => event.runId === input.runId),
    pollingError: input.pollingError ?? null,
    afterScreenshotError: input.afterScreenshotError ?? null,
    trace: {
      path: trace ? tracePath : null,
      eventTypes: summarizeTraceEventTypes(trace),
      error: traceError,
    },
    sqlite: {
      path: sqliteEvidence ? sqlitePath : null,
      eventTypes: summarizeSqliteEventTypes(sqliteEvidence),
      runStatus: sqliteEvidence?.run?.status ?? null,
      runErrorText: formatSafeOptionalText(sqliteEvidence?.run?.errorText),
      error: sqliteError,
    },
  }

  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return { summaryPath, tracePath: trace ? tracePath : null, sqlitePath: sqliteEvidence ? sqlitePath : null }
}

function summarizeTraceEventTypes(trace) {
  const events = Array.isArray(trace?.events) ? trace.events : []
  return events.map((event) => String(event.eventType ?? "unknown"))
}

function summarizeSqliteEventTypes(sqliteEvidence) {
  const events = Array.isArray(sqliteEvidence?.runEvents) ? sqliteEvidence.runEvents : []
  return events.map((event) => String(event.eventType ?? "unknown"))
}

function formatSafeDiagnosticError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return formatSafeOptionalText(message) ?? "unknown error"
}

function formatSafeOptionalText(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null
  }

  let safe = value
  if (liveLlm.apiKey) {
    safe = safe.split(liveLlm.apiKey).join("[REDACTED_API_KEY]")
  }
  return safe.length > 1_000 ? `${safe.slice(0, 1_000)}…` : safe
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

function getTelemetryToolName(event) {
  return event?.data?.toolName ?? event?.data?.tool ?? event?.data?.name ?? null
}

function assertReadToolCall(sqliteEvidence, attemptId) {
  const events = sqliteEvidence.runEvents ?? []
  const hasReadCall = events.some((event) => {
    if (event.eventType !== "tool.call.requested" && event.eventType !== "tool.call.completed") {
      return false
    }
    return getTelemetryToolName(event) === "read"
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
    const toolName = getTelemetryToolName(event)
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
    const name = getTelemetryToolName(event)
    return name === toolName
  }).length
}
