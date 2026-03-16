export function createToolPermissionDeniedError() {
  const error = new Error("Permission denied")
  error.name = "ToolPermissionDeniedError"
  return error
}
