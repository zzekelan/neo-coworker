import { _electron as electron } from "playwright"

const cwd = process.cwd()
const prompt = process.env.DESKTOP_VERIFY_PROMPT?.trim() || "Reply with exactly OK."
const expectedAssistantText =
  process.env.DESKTOP_VERIFY_EXPECTED_TEXT?.trim() || "OK."

const app = await electron.launch({
  args: ["src/desktop/electron/main.mjs"],
  cwd,
  env: { ...process.env },
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

  await page.getByRole("button", { name: /Settings|设置/ }).click()
  await page.waitForSelector("text=.agents/desktop-settings.json", { timeout: 10_000 })
  const settingsSnapshot = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("select"))
    return {
      language: selects[0] instanceof HTMLSelectElement ? selects[0].value : null,
      provider: selects[1] instanceof HTMLSelectElement ? selects[1].value : null,
    }
  })
  await page.getByRole("button", { name: "Close", exact: true }).click()

  const workspaceRoot = await page.evaluate(
    () =>
      window.neoCoworkerDesktop.persistedWorkspaceRoot ??
      window.neoCoworkerDesktop.defaultWorkspaceRoot ??
      null,
  )
  if (!workspaceRoot) {
    throw new Error("Desktop bridge did not expose a default workspace root.")
  }

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

  await page.locator("textarea").fill(prompt)
  await page.locator("button[type=submit]").click()

  let latestRunStatus = null
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const sessionResponse = await requestJson(`/sessions/${encodeURIComponent(sessionId)}`)
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
      throw new Error("Unexpected permission request while validating the simple desktop path.")
    }

    await page.waitForTimeout(500)
  }

  if (latestRunStatus !== "completed") {
    throw new Error(
      `Desktop run did not complete successfully (status: ${latestRunStatus ?? "missing"}).`,
    )
  }

  const transcriptResponse = await requestJson(`/sessions/${encodeURIComponent(sessionId)}/transcript`)
  const transcript = transcriptResponse.body?.data?.transcript ?? []
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

  if (!assistantPreview) {
    throw new Error("Assistant transcript text is empty.")
  }

  if (expectedAssistantText && assistantPreview.includes(expectedAssistantText) === false) {
    throw new Error(
      `Assistant transcript did not include the expected text: ${expectedAssistantText}`,
    )
  }

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        settingsSnapshot,
        sessionId,
        latestRunStatus,
        transcriptCount: transcript.length,
        assistantPreview,
      },
      null,
      2,
    ),
  )
} finally {
  await app.close()
}
