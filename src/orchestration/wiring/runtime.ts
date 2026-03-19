type BootstrapRuntimeModule = typeof import("../../bootstrap/runtime")

const bootstrapRuntime: BootstrapRuntimeModule = await import("../../bootstrap/runtime")

export const PermissionRequestNotAwaitingActiveRuntimeError =
  bootstrapRuntime.PermissionRequestNotAwaitingActiveRuntimeError
export const createRuntime = bootstrapRuntime.createRuntime
export const createCliRuntime = bootstrapRuntime.createCliRuntime
export const getDefaultCliStoragePath = bootstrapRuntime.getDefaultCliStoragePath
