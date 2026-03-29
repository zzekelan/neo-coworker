export function createToolPermissionDeniedError() {
  const error = new Error("Permission denied")
  error.name = "ToolPermissionDeniedError"
  return error
}

export function createToolSetupError(message: string) {
  const error = new Error(message)
  error.name = "ToolSetupError"
  return error
}
