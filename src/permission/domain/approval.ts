export type PatchApprovalFileOperation = "add" | "delete" | "move" | "update"

export type PatchApprovalFile = {
  path: string
  operation: PatchApprovalFileOperation
  additions: number
  deletions: number
}

export type PatchApprovalDetails = {
  kind: "patch"
  fileCount: number
  additions: number
  deletions: number
  files: PatchApprovalFile[]
}

export type PatchApprovalPreview = {
  kind: "patch"
  text: string
  truncated: boolean
  limitBytes: number
  originalBytes: number
  displayedBytes: number
}

export type PermissionApprovalDetails = PatchApprovalDetails
export type PermissionApprovalPreview = PatchApprovalPreview
