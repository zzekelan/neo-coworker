export function hasVisibleWorkspaceSelect(workspaceCount: number) {
  return workspaceCount >= 0
}

export function inferWorkspaceParentDirectory(
  workspaceRoot: string | null | undefined,
  platform?: string,
) {
  if (!workspaceRoot) {
    return ""
  }

  const separator = detectPathSeparator(workspaceRoot, platform)
  const normalized = trimTrailingSeparators(workspaceRoot, separator)

  if (!normalized) {
    return workspaceRoot
  }

  const boundary = normalized.lastIndexOf(separator)
  if (boundary === -1) {
    return ""
  }

  if (boundary === 0) {
    return separator
  }

  return normalized.slice(0, boundary)
}

export function buildWorkspaceDirectory(input: {
  parentDirectory: string
  workspaceName: string
  platform?: string
}) {
  const parentDirectory = input.parentDirectory.trim()
  const workspaceName = input.workspaceName.trim()
  if (!parentDirectory || !workspaceName) {
    return null
  }

  const separator = detectPathSeparator(parentDirectory, input.platform)
  const normalizedParent = trimTrailingSeparators(parentDirectory, separator)
  if (!normalizedParent) {
    return `${separator}${workspaceName}`
  }

  if (normalizedParent.endsWith(":")) {
    return `${normalizedParent}${separator}${workspaceName}`
  }

  return `${normalizedParent}${separator}${workspaceName}`
}

function detectPathSeparator(path: string, platform?: string) {
  if (path.includes("\\")) {
    return "\\"
  }

  return platform === "win32" ? "\\" : "/"
}

function trimTrailingSeparators(path: string, separator: string) {
  if (path === separator) {
    return path
  }

  if (/^[A-Za-z]:\\?$/.test(path)) {
    return path.endsWith("\\") ? path.slice(0, -1) : path
  }

  return path.replace(new RegExp(`${escapeForRegExp(separator)}+$`), "")
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
