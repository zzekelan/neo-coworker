import { _electron as electron } from "playwright"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const cwd = process.cwd()
const isolatedDesktopStateRoot = mkdtempSync(join(tmpdir(), "neo-coworker-desktop-subsession-verify-"))
const workspaceRoot = join(isolatedDesktopStateRoot, "workspace")
const evidenceRoot = join(cwd, ".sisyphus", "evidence")
const serverDatabasePath =
  process.env.NCOWORKER_SERVER_DB_PATH?.trim() ||
  process.env.AGENT_SERVER_DB_PATH?.trim() ||
  join(isolatedDesktopStateRoot, "server.sqlite")
const evidenceJsonPath = join(evidenceRoot, "task-12-sidebar-sessions.json")
const screenshotPath = join(evidenceRoot, "task-12-buttons-test.png")
const topLevelSessionTitle = "Task 12 top-level session"
const subSessionTitle = "Task 12 hidden sub-session"

mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(evidenceRoot, { recursive: true })

const app = await electron.launch({
  args: ["src/desktop/electron/main.mjs"],
  cwd,
  env: {
    ...process.env,
    DESKTOP_WORKSPACE_ROOT: workspaceRoot,
    DESKTOP_SELECTION_STATE_PATH:
      process.env.DESKTOP_SELECTION_STATE_PATH?.trim() ||
      join(isolatedDesktopStateRoot, "desktop-state.json"),
    DESKTOP_SETTINGS_STATE_PATH:
      process.env.DESKTOP_SETTINGS_STATE_PATH?.trim() ||
      join(isolatedDesktopStateRoot, "desktop-settings.json"),
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

try {
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => document.body.innerText.includes("NeoCoworker"), null, {
    timeout: 20_000,
  })
  await page.getByTitle("New Session").waitFor({ timeout: 20_000 })
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

  const createdSessionResponse = await requestJson("/sessions", "POST", {
    directory: workspaceRoot,
    workspaceRoot,
    title: topLevelSessionTitle,
  })
  const createdSession = unwrapSession(createdSessionResponse, "create top-level session")

  await page.waitForFunction(
    (expectedTitle) => {
      return Array.from(document.querySelectorAll("button")).some(
        (button) => button.innerText.trim() === expectedTitle,
      )
    },
    topLevelSessionTitle,
    { timeout: 20_000 },
  )

  const beforeSessionsResponse = await requestJson("/sessions")
  const beforeSessions = unwrapSessions(beforeSessionsResponse, "list top-level sessions before child insert")
  assertSessionIds(beforeSessions, [createdSession.id], "GET /sessions before child insert")

  const childInserted = insertSubSession({
    databasePath: serverDatabasePath,
    parentSession: createdSession,
    workspaceRoot,
    title: subSessionTitle,
  })

  const afterSessionsResponse = await requestJson("/sessions")
  const afterSessions = unwrapSessions(afterSessionsResponse, "list top-level sessions after child insert")
  assertSessionIds(afterSessions, [createdSession.id], "GET /sessions after child insert")
  assert(
    afterSessions.some((session) => session.id === childInserted.id) === false,
    "GET /sessions unexpectedly returned the inserted sub-session.",
  )

  const workspaceSessionsPath = `/workspace/sessions?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
  const workspaceSessionsResponse = await requestJson(workspaceSessionsPath)
  const workspaceSessions = unwrapSessions(
    workspaceSessionsResponse,
    "list workspace sessions after child insert",
  )
  assertSessionIds(workspaceSessions, [createdSession.id], "GET /workspace/sessions after child insert")
  assert(
    workspaceSessions.some((session) => session.id === childInserted.id) === false,
    "GET /workspace/sessions unexpectedly returned the inserted sub-session.",
  )

  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.body.innerText.includes("NeoCoworker"), null, {
    timeout: 20_000,
  })
  await page.getByTitle("New Session").waitFor({ timeout: 20_000 })
  await page.waitForFunction(
    (expectedTitle) => {
      return Array.from(document.querySelectorAll("button")).some(
        (button) => button.innerText.trim() === expectedTitle,
      )
    },
    topLevelSessionTitle,
    { timeout: 20_000 },
  )

  const sidebarButtonTexts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button"))
      .map((button) => button.innerText.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  })

  assert(
    sidebarButtonTexts.includes(topLevelSessionTitle),
    "Desktop sidebar did not show the top-level session.",
  )
  assert(
    sidebarButtonTexts.includes(subSessionTitle) === false,
    "Desktop sidebar unexpectedly rendered the sub-session entry.",
  )

  writeFileSync(
    evidenceJsonPath,
    `${JSON.stringify(
      {
        workspaceRoot,
        serverDatabasePath,
        topLevelSession: createdSession,
        insertedSubSession: childInserted,
        sessionsResponse: afterSessionsResponse.body,
        workspaceSessionsResponse: workspaceSessionsResponse.body,
        sidebarButtonTexts,
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
        topLevelSessionId: createdSession.id,
        subSessionId: childInserted.id,
        sidebarButtonTexts,
        evidenceJsonPath,
        screenshotPath,
      },
      null,
      2,
    ),
  )
} finally {
  await app.close()
  rmSync(isolatedDesktopStateRoot, { recursive: true, force: true })
}

function unwrapSession(response, label) {
  assert(response?.ok, `${label} failed with status ${response?.status ?? "unknown"}.`)
  const session = response.body?.data?.session ?? null
  assert(session, `${label} did not return a session payload.`)
  return session
}

function unwrapSessions(response, label) {
  assert(response?.ok, `${label} failed with status ${response?.status ?? "unknown"}.`)
  const sessions = response.body?.data?.sessions
  assert(Array.isArray(sessions), `${label} did not return a sessions array.`)
  return sessions
}

function assertSessionIds(sessions, expectedIds, label) {
  const actualIds = sessions.map((session) => session.id)
  assert(
    actualIds.length === expectedIds.length,
    `${label} returned ${actualIds.length} sessions instead of ${expectedIds.length}: ${actualIds.join(", ")}`,
  )

  for (const expectedId of expectedIds) {
    assert(actualIds.includes(expectedId), `${label} did not include expected session ${expectedId}.`)
  }
}

function insertSubSession(input) {
  const db = new DatabaseSync(input.databasePath)

  try {
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")

    const createdAt = Math.max(Date.now(), input.parentSession.updatedAt + 10_000)
    const subSessionId = `session_task12_sub_${createdAt}`
    const subSessionDirectory = join(input.workspaceRoot, "sub-session")
    mkdirSync(subSessionDirectory, { recursive: true })

    db.prepare(
      `
        INSERT INTO session (
          id,
          directory,
          workspace_root,
          created_at,
          title,
          updated_at,
          latest_user_message_preview,
          active_skills_json,
          parent_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      subSessionId,
      subSessionDirectory,
      input.workspaceRoot,
      createdAt,
      input.title,
      createdAt,
      null,
      JSON.stringify(input.parentSession.activeSkills ?? []),
      input.parentSession.id,
    )

    return {
      id: subSessionId,
      directory: subSessionDirectory,
      workspaceRoot: input.workspaceRoot,
      title: input.title,
      parentSessionId: input.parentSession.id,
      createdAt,
      updatedAt: createdAt,
    }
  } finally {
    db.close()
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
