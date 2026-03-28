export function createQuitCoordinator(input) {
  let cleanupComplete = false
  let cleanupPromise = null

  return {
    handleBeforeQuit(event) {
      if (cleanupComplete) {
        return
      }

      event.preventDefault()

      if (cleanupPromise) {
        return
      }

      cleanupPromise = beginCleanup(input.cleanup).finally(() => {
        cleanupComplete = true
        input.quit()
      })
    },
    async cleanupNow() {
      if (cleanupComplete) {
        return
      }

      if (!cleanupPromise) {
        cleanupPromise = beginCleanup(input.cleanup).finally(() => {
          cleanupComplete = true
        })
      }

      await cleanupPromise
    },
  }
}

export function createChildHandle(child, input = {}) {
  const exitTimeoutMs = input.exitTimeoutMs ?? 5_000
  let closingPromise = null

  return {
    close() {
      if (child.exitCode != null) {
        return Promise.resolve()
      }

      if (closingPromise) {
        return closingPromise
      }

      safeKill(child, "SIGTERM")

      closingPromise = waitForChildExit(child, exitTimeoutMs)
      return closingPromise
    },
  }
}

export async function waitForManagedChildStartup(input) {
  const handle = createChildHandle(input.child, input.handleOptions)
  input.assignHandle?.(handle)

  try {
    return await input.waitUntilReady()
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function waitForChildExit(child, timeoutMs) {
  await new Promise((resolvePromise) => {
    if (child.exitCode != null) {
      resolvePromise()
      return
    }

    const timeout = setTimeout(() => {
      safeKill(child, "SIGKILL")
    }, timeoutMs)

    child.once("exit", () => {
      clearTimeout(timeout)
      resolvePromise()
    })
  })
}

function safeKill(child, signal) {
  if (child.exitCode != null) {
    return
  }

  try {
    child.kill(signal)
  } catch {
    // Ignore kill races while shutting down.
  }
}

function beginCleanup(cleanup) {
  try {
    return Promise.resolve(cleanup())
  } catch (error) {
    return Promise.reject(error)
  }
}
