import { spawn } from "node:child_process"
import { accessSync, appendFileSync, constants as fsConstants, existsSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import http from "node:http"
import https from "node:https"
import { app, BrowserWindow, dialog, ipcMain } from "electron"
import { createQuitCoordinator, waitForManagedChildStartup } from "./lifecycle.mjs"
import {
  readDesktopSelectionState,
  writeDesktopSelectionState,
} from "./selection-state.mjs"
import {
  createDefaultDesktopSettings,
  readDesktopSettingsEnvFiles,
  readDesktopSettingsState,
  writeDesktopSettingsState,
} from "./settings-state.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(__dirname, "..")
const repositoryRoot = resolve(__dirname, "..", "..", "..")
const preloadPath = resolve(__dirname, "preload.cjs")
const workspaceRoot =
  process.env.DESKTOP_WORKSPACE_ROOT || resolveLegacyDesktopPath(repositoryRoot, "workspace")
const desktopSelectionStatePath = resolveLegacyDesktopPath(repositoryRoot, "desktop-state.json")
const desktopSettingsStatePath = resolveLegacyDesktopPath(repositoryRoot, "desktop-settings.json")
const desktopServerDatabasePath =
  (process.env.NCOWORKER_SERVER_DB_PATH?.trim() || process.env.AGENT_SERVER_DB_PATH?.trim()) || resolveLegacyDesktopPath(repositoryRoot, "server.sqlite")
const persistedSelection = readDesktopSelectionState(desktopSelectionStatePath)
const defaultDesktopSettings = createDefaultDesktopSettings({
  ...readDesktopSettingsEnvFiles(repositoryRoot),
  ...process.env,
})
let desktopSettings = readDesktopSettingsState(desktopSettingsStatePath, defaultDesktopSettings)
const bunBin = resolveBunExecutable()
const bootstrapLogPath = process.env.DESKTOP_BOOTSTRAP_LOG?.trim() || null

let appServerHandle = null
let uiServerHandle = null
let eventBridgeHandle = null
let currentServerOrigin = null
let currentServerMode = "managed-local"
let runtimeCleanupPromise = null
let unavailableServerMessage = null

app.disableHardwareAcceleration()

app.on("window-all-closed", () => {
  app.quit()
})

const quitCoordinator = createQuitCoordinator({
  cleanup: closeRuntimeHandles,
  quit() {
    app.quit()
  },
})

app.on("before-quit", (event) => {
  quitCoordinator.handleBeforeQuit(event)
})

app.whenReady().then(startDesktop).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  void quitCoordinator.cleanupNow().finally(() => {
    app.exit(1)
  })
})

async function startDesktop() {
  logBootstrap("ready")
  currentServerMode = readConfiguredServerOrigin(
      process.env.NCOWORKER_SERVER_URL ?? process.env.AGENT_SERVER_URL,
    )
    ? "external"
    : "managed-local"
  const uiOrigin = await startUiServer()
  const window = createWindow({
    defaultWorkspaceRoot: workspaceRoot,
    persistedWorkspaceRoot: persistedSelection?.activeWorkspaceRoot ?? null,
    persistedSessionId: persistedSelection?.activeSessionId ?? null,
    serverMode: currentServerMode,
  })

  ipcMain.handle("neo-coworker:request-json", async (_event, input) => {
    return requestJson(currentServerOrigin, input)
  })
  ipcMain.handle("neo-coworker:pick-directory", async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
    })

    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle("neo-coworker:persist-selection", async (_event, selection) => {
    writeDesktopSelectionState(desktopSelectionStatePath, selection)
    return true
  })
  ipcMain.handle("neo-coworker:load-settings", async () => {
    return {
      settings: desktopSettings,
      serverMode: currentServerMode,
    }
  })
  ipcMain.handle("neo-coworker:save-settings", async (_event, settings) => {
    desktopSettings = writeDesktopSettingsState(
      desktopSettingsStatePath,
      settings,
      defaultDesktopSettings,
    )
    return {
      settings: desktopSettings,
      serverMode: currentServerMode,
    }
  })
  ipcMain.handle("neo-coworker:apply-settings", async (_event, settings) => {
    desktopSettings = writeDesktopSettingsState(
      desktopSettingsStatePath,
      settings,
      defaultDesktopSettings,
    )

    if (currentServerMode !== "managed-local") {
      return {
        settings: desktopSettings,
        serverMode: currentServerMode,
        restarted: false,
      }
    }

    await ensureNoActiveRuns(currentServerOrigin)
    try {
      currentServerOrigin = await restartManagedLocalServer({
        settings: desktopSettings,
        window,
      })
      unavailableServerMessage = null
    } catch (error) {
      await setManagedLocalServerUnavailable(error)
      throw error
    }

    return {
      settings: desktopSettings,
      serverMode: currentServerMode,
      restarted: true,
    }
  })

  try {
    currentServerOrigin = await resolveServerOrigin({
      serverMode: currentServerMode,
      settings: desktopSettings,
    })
    unavailableServerMessage = null
    await replaceEventBridge({
      serverOrigin: currentServerOrigin,
      window,
    })
  } catch (error) {
    currentServerOrigin = null
    recordUnavailableServer(error)
  }

  await window.loadURL(uiOrigin)
  logBootstrap(`window.loaded ${uiOrigin}`)
}

function createWindow(input) {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      additionalArguments: [
        `--neo-coworker-default-workspace-root=${encodeURIComponent(input.defaultWorkspaceRoot)}`,
        `--neo-coworker-platform=${encodeURIComponent(process.platform)}`,
        `--neo-coworker-server-mode=${encodeURIComponent(input.serverMode)}`,
        ...(input.persistedWorkspaceRoot
          ? [
              `--neo-coworker-persisted-workspace-root=${encodeURIComponent(
                input.persistedWorkspaceRoot,
              )}`,
            ]
          : []),
        ...(input.persistedSessionId
          ? [`--neo-coworker-persisted-session-id=${encodeURIComponent(input.persistedSessionId)}`]
          : []),
      ],
    },
  })

  window.on("ready-to-show", () => {
    logBootstrap("window.ready")
  })

  return window
}

function closeRuntimeHandles() {
  if (runtimeCleanupPromise) {
    return runtimeCleanupPromise
  }

  runtimeCleanupPromise = Promise.allSettled([
    eventBridgeHandle?.close?.(),
    appServerHandle?.close?.(),
    uiServerHandle?.close?.(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(result.reason)
      }
    }
  })

  return runtimeCleanupPromise
}

async function resolveServerOrigin(input) {
  const configuredOrigin = readConfiguredServerOrigin(
    process.env.NCOWORKER_SERVER_URL ?? process.env.AGENT_SERVER_URL,
  )
  if (input.serverMode === "external") {
    logBootstrap(`server.external ${configuredOrigin}`)
    return configuredOrigin
  }

  if (process.env.DESKTOP_DISABLE_LOCAL_SERVER === "1") {
    throw new Error("AGENT_SERVER_URL is required when DESKTOP_DISABLE_LOCAL_SERVER=1")
  }

  return startManagedLocalServer(input.settings)
}

async function startManagedLocalServer(settings) {
  const port = await allocateLoopbackPort()
  const env = buildManagedServerEnv({
    settings,
    port,
  })
  logBootstrap(`server.local.start ${port}`)
  const child = spawn(bunBin, ["run", "src/app-server/main.ts"], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const startedOrigin = await waitForManagedChildStartup({
    child,
    assignHandle(handle) {
      appServerHandle = handle
    },
    waitUntilReady() {
      return waitForServerStarted(child, `http://127.0.0.1:${port}`)
    },
  })
  unavailableServerMessage = null
  logBootstrap(`server.local.ready ${startedOrigin}`)
  return startedOrigin
}

async function replaceEventBridge(input) {
  await eventBridgeHandle?.close?.()
  eventBridgeHandle = createEventBridge({
    serverOrigin: input.serverOrigin,
    window: input.window,
  })
  eventBridgeHandle.start()
}

async function restartManagedLocalServer(input) {
  await eventBridgeHandle?.close?.()
  eventBridgeHandle = null
  await appServerHandle?.close?.()
  appServerHandle = null

  const nextOrigin = await startManagedLocalServer(input.settings)
  await replaceEventBridge({
    serverOrigin: nextOrigin,
    window: input.window,
  })

  return nextOrigin
}

async function setManagedLocalServerUnavailable(error) {
  if (currentServerMode !== "managed-local") {
    return false
  }

  currentServerOrigin = null
  recordUnavailableServer(error)

  const handle = eventBridgeHandle
  eventBridgeHandle = null
  await handle?.close?.()
  return true
}

function recordUnavailableServer(error) {
  unavailableServerMessage = toErrorMessage(error)
  logBootstrap(`server.unavailable ${sanitizeBootstrapMessage(unavailableServerMessage)}`)
  console.error(unavailableServerMessage)
}

async function ensureNoActiveRuns(origin) {
  if (!origin) {
    return
  }

  const response = await requestJson(origin, {
    path: "/sessions",
  })

  if (response.status === 503) {
    return
  }

  if (!response.ok) {
    throw new Error("Desktop could not verify session activity before restarting the local app-server.")
  }

  const sessions = Array.isArray(response.body?.data?.sessions)
    ? response.body.data.sessions
    : []
  const busySession = sessions.find((session) => isBusySessionRunStatus(session?.latestRunStatus))

  if (busySession) {
    throw new Error("Stop the active run before applying LLM settings.")
  }
}

function isBusySessionRunStatus(status) {
  return status === "queued" || status === "running" || status === "waiting_permission"
}

function buildManagedServerEnv(input) {
  const env = buildLoopbackEnv({
    NCOWORKER_SERVER_HOST: "127.0.0.1",
    NCOWORKER_SERVER_PORT: String(input.port),
    NCOWORKER_SERVER_DB_PATH: desktopServerDatabasePath,
  })

  delete env.LLM_PROVIDER
  delete env.LLM_API_KEY
  delete env.LLM_MODEL
  delete env.LLM_BASE_URL
  delete env.LLM_TIMEOUT_MS

  env.LLM_PROVIDER = input.settings.provider
  env.LLM_API_KEY = input.settings.apiKey
  env.LLM_MODEL = input.settings.model
  if (input.settings.baseURL) {
    env.LLM_BASE_URL = input.settings.baseURL
  }
  if (input.settings.timeoutMs) {
    env.LLM_TIMEOUT_MS = input.settings.timeoutMs
  }

  return env
}

async function startUiServer() {
  const configuredUiOrigin = process.env.DESKTOP_UI_URL?.trim()
  if (configuredUiOrigin) {
    logBootstrap(`ui.external ${configuredUiOrigin}`)
    return configuredUiOrigin
  }

  const port = await allocateLoopbackPort()
  const viteBin = resolve(desktopRoot, "node_modules", ".bin", "vite")
  logBootstrap(`ui.local.start ${port}`)
  const child = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: desktopRoot,
    env: buildLoopbackEnv({}),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const origin = `http://127.0.0.1:${port}`
  await waitForManagedChildStartup({
    child,
    assignHandle(handle) {
      uiServerHandle = handle
    },
    waitUntilReady() {
      return waitForChildReady(child, `Vite dev server (${origin})`, waitForHttpReady(`${origin}/`))
    },
  })
  logBootstrap(`ui.local.ready ${origin}`)
  return origin
}

function createEventBridge(input) {
  let closed = false
  let activeRequest = null
  let reconnectTimer = null

  function start() {
    connect()
  }

  async function close() {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (activeRequest) {
      activeRequest.destroy()
      activeRequest = null
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) {
      return
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, 1000)
  }

  function connect() {
    if (closed) {
      return
    }

    const url = new URL("/events", input.serverOrigin)
    const client = url.protocol === "https:" ? https : http
    const request = client.request(url, { method: "GET" })
    activeRequest = request

    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        handleBridgeError({
          status: response.statusCode ?? 0,
        })
        response.resume()
        return
      }

      let buffer = ""

      response.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        while (true) {
          const boundary = buffer.indexOf("\n\n")
          if (boundary === -1) {
            break
          }

          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseEvent(rawEvent)
          if (!parsed) {
            continue
          }

          input.window.webContents.send("neo-coworker:event", parsed)
        }
      })

      response.on("end", () => {
        if (!closed) {
          handleBridgeError({ reason: "stream-ended" })
        }
      })

      response.on("error", (error) => {
        if (!closed) {
          handleBridgeError({ reason: error.message })
        }
      })
    })

    request.on("error", (error) => {
      if (!closed) {
        handleBridgeError({ reason: error.message })
      }
    })

    request.end()
  }

  function handleBridgeError(detail) {
    input.window.webContents.send("neo-coworker:event-error", detail)

    if (currentServerMode === "managed-local") {
      void setManagedLocalServerUnavailable(
        detail.reason ?? `Managed local app-server bridge failed with status ${detail.status ?? 0}.`,
      )
      return
    }

    scheduleReconnect()
  }

  return {
    start,
    close,
  }
}

async function requestJson(origin, input) {
  if (!origin) {
    return createUnavailableServerResponse()
  }

  const url = new URL(input.path, origin)
  const body = input.body === undefined ? undefined : JSON.stringify(input.body)
  let response

  try {
    response = await requestUrl(url, {
      method: input.method ?? (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body,
    })
  } catch (error) {
    if (await setManagedLocalServerUnavailable(error)) {
      return createUnavailableServerResponse()
    }
    throw error
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    body: response.body,
  }
}

function createUnavailableServerResponse() {
  const detail = unavailableServerMessage
    ? `${unavailableServerMessage} Open Settings, configure the LLM fields, and apply them to start the local server.`
    : "The desktop app-server is unavailable. Open Settings, configure the LLM fields, and apply them to start the local server."

  return {
    ok: false,
    status: 503,
    body: {
      error: {
        message: detail,
      },
    },
  }
}

function requestUrl(url, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const client = url.protocol === "https:" ? https : http
    const request = client.request(
      url,
      {
        method: input.method,
        headers: input.headers,
      },
      (response) => {
        let payload = ""

        response.on("data", (chunk) => {
          payload += chunk.toString("utf8")
        })

        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 500,
            body: parseJsonBody(payload),
          })
        })
      },
    )

    request.on("error", rejectPromise)

    if (input.body !== undefined) {
      request.write(input.body)
    }

    request.end()
  })
}

async function waitForServerStarted(child, fallbackOrigin) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = ""
    let settled = false

    const timeout = setTimeout(() => {
      settled = true
      child.kill("SIGTERM")
      rejectPromise(new Error("Timed out waiting for the local app-server to start"))
    }, 20_000)

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      const text = String(chunk)
      if (!bootstrapLogPath) {
        process.stdout.write(text)
      }
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        if (!line.startsWith("server.started ")) {
          continue
        }

        settled = true
        clearTimeout(timeout)
        resolvePromise(line.slice("server.started ".length).trim() || fallbackOrigin)
      }
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      const text = String(chunk)
      stderr += text
      if (!bootstrapLogPath) {
        process.stderr.write(text)
      }
    })

    child.once("error", (error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      rejectPromise(new Error(`Failed to start local app-server: ${error.message}`))
    })

    child.once("exit", (code) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      rejectPromise(new Error(stderr || `Local app-server exited with code ${code ?? 0}`))
    })
  })
}

async function waitForChildReady(child, label, readyPromise) {
  await Promise.race([
    readyPromise,
    new Promise((_, rejectPromise) => {
      child.once("error", (error) => {
        rejectPromise(new Error(`Failed to start ${label}: ${error.message}`))
      })

      child.once("exit", (code) => {
        rejectPromise(new Error(`${label} exited before it became ready (code ${code ?? 0})`))
      })
    }),
  ])
}

async function waitForHttpReady(url) {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    try {
      const response = await requestUrl(new URL(url), {
        method: "GET",
        headers: {},
      })
      if (response.status >= 200 && response.status < 500) {
        return
      }
    } catch {
      // Server is still starting.
    }

    await delay(200)
  }

  throw new Error(`Timed out waiting for ${url}`)
}

function allocateLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer()
    server.once("error", rejectPromise)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => rejectPromise(new Error("Failed to allocate a loopback port")))
        return
      }

      server.close((error) => {
        if (error) {
          rejectPromise(error)
          return
        }

        resolvePromise(address.port)
      })
    })
  })
}

function resolveBunExecutable() {
  const candidates = []

  if (process.env.BUN) {
    candidates.push(process.env.BUN)
  }

  if (process.env.BUN_BIN) {
    candidates.push(process.env.BUN_BIN)
  }

  if (process.env.PATH) {
    for (const entry of process.env.PATH.split(delimiter)) {
      if (!entry) {
        continue
      }

      candidates.push(join(entry, "bun"))
    }
  }

  candidates.push(join(homedir(), ".bun", "bin", "bun"))

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Keep searching.
    }
  }

  throw new Error("Unable to locate bun. Set BUN_BIN to the bun executable path before launching Electron.")
}

function readConfiguredServerOrigin(value) {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  const url = new URL(trimmed)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AGENT_SERVER_URL must use http or https")
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AGENT_SERVER_URL must not include a path, query, or hash")
  }

  return url.origin
}

function buildLoopbackEnv(overrides) {
  const env = { ...process.env }
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

function resolveLegacyDesktopPath(root, fileName) {
  const nextPath = resolve(root, ".ncoworker", fileName)
  const legacyPath = resolve(root, ".agents", fileName)
  return existsSync(legacyPath) && !existsSync(nextPath) ? legacyPath : nextPath
}

function parseSseEvent(rawEvent) {
  const dataLines = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) {
    return null
  }

  return JSON.parse(dataLines.join("\n"))
}

function parseJsonBody(payload) {
  if (!payload) {
    return null
  }

  try {
    return JSON.parse(payload)
  } catch {
    return {
      error: {
        message: payload,
      },
    }
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

function logBootstrap(message) {
  const line = `desktop.bootstrap ${message}`
  if (bootstrapLogPath) {
    appendFileSync(bootstrapLogPath, `${line}\n`)
    return
  }

  console.log(line)
}

function sanitizeBootstrapMessage(message) {
  return message.replace(/\s+/g, " ").trim()
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
