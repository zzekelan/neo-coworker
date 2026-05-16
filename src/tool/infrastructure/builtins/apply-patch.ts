import { z } from "zod"
import {
  throwIfToolAborted,
  type RequestToolPermission,
  type ToolDefinition,
} from "../../domain"
import { createToolPermissionDeniedError } from "./errors"
import {
  applyPatchPlan,
  formatPatchToolResult,
  planApplyPatch,
  type PatchPlan,
} from "./apply-patch-engine"
import {
  type AtomicUtf8FileWrite,
  withSerializedFileMutations,
} from "./mutating-file"

const PATCH_APPROVAL_PREVIEW_LIMIT = 64 * 1024
const PATCH_TEXT_DESCRIPTION =
  "Codex/opencode patch text beginning with `*** Begin Patch` and ending with `*** End Patch`. Supports `*** Add File: path` with every content line prefixed by `+`, `*** Update File: path` hunks using `@@` plus context/`-`/`+` lines, `*** Delete File: path`, and `*** Move to: newPath` after an update header. This is not a unified diff; do not use `---`/`+++` headers or `create file:`."

const ApplyPatchArgsSchema = z.object({
  patchText: z.string().trim().min(1, "Patch text must not be empty").describe(
    PATCH_TEXT_DESCRIPTION,
  ),
}).describe(
  "Apply a Codex/opencode patch to workspace files. The patch is submitted as JSON through `patchText`, never through shell. Supports explicit file mutation through the permissioned Apply Patch Tool path.",
)

export function createApplyPatchTool(input: {
  requestPermission: RequestToolPermission
  atomicWrite?: AtomicUtf8FileWrite
}): ToolDefinition {
  return {
    name: "apply_patch",
    description:
      "Apply a Codex/opencode patch to workspace files using JSON input. Use this as the primary mutation surface for targeted file edits. Submit patch text in `patchText`; do not invoke apply_patch through shell.",
    inputSchema: ApplyPatchArgsSchema,
    concurrency: "mutating",
    isCompressible: false,
    usageGuidance:
      "Use `apply_patch` for workspace file mutations. Provide a full patch envelope in `patchText`: `*** Begin Patch`, then operations such as `*** Add File: path` followed by `+line`, `*** Update File: path` with `@@` hunks, or `*** Delete File: path`, then `*** End Patch`. Do not use shell heredocs, unified diff headers (`---`/`+++`), or `create file:`.",
    async execute(value) {
      throwIfToolAborted(value.signal)
      const parsedArgs = ApplyPatchArgsSchema.safeParse(value.args)
      if (!parsedArgs.success) {
        return {
          output: parsedArgs.error.issues.map((issue) => issue.message).join("; "),
          isError: true,
        }
      }

      const { patchText } = parsedArgs.data
      let plan: PatchPlan

      try {
        plan = await planApplyPatch({
          workspaceRoot: value.workspaceRoot,
          patchText,
        })
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }

      const decision = await input.requestPermission({
        toolName: "apply_patch",
        reason: `apply_patch ${plan.summaries.map((change) => change.path).join(", ")}`,
        approvalDetails: buildPatchApprovalDetails(plan),
        preview: buildPatchApprovalPreview(plan),
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(value.signal)

      let committedPlan: PatchPlan
      try {
        committedPlan = await withSerializedFileMutations(getPatchLockPaths(plan), async () => {
          throwIfToolAborted(value.signal)
          const latestPlan = await planApplyPatch({
            workspaceRoot: value.workspaceRoot,
            patchText,
          })
          throwIfToolAborted(value.signal)
          await applyPatchPlan(latestPlan, {
            atomicWrite: input.atomicWrite,
          })
          return latestPlan
        })
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }

      return {
        output: formatPatchToolResult(committedPlan),
        metadata: {
          files: committedPlan.summaries,
          fileCount: committedPlan.changes.length,
          additions: committedPlan.totalAdditions,
          deletions: committedPlan.totalDeletions,
        },
      }
    },
  }
}

function getPatchLockPaths(plan: PatchPlan) {
  return plan.changes.flatMap((change) =>
    change.previousAbsolutePath
      ? [change.previousAbsolutePath, change.absolutePath]
      : [change.absolutePath]
  )
}

function buildPatchApprovalDetails(plan: PatchPlan) {
  return {
    kind: "patch" as const,
    fileCount: plan.changes.length,
    additions: plan.totalAdditions,
    deletions: plan.totalDeletions,
    files: plan.summaries.map((change) => ({
      path: change.path,
      operation: change.operation,
      additions: change.additions,
      deletions: change.deletions,
    })),
  }
}

function buildPatchApprovalPreview(plan: PatchPlan) {
  const preview = truncateUtf8WithNotice(plan.diff, PATCH_APPROVAL_PREVIEW_LIMIT)

  return {
    kind: "patch" as const,
    text: preview.text,
    truncated: preview.truncated,
    limitBytes: PATCH_APPROVAL_PREVIEW_LIMIT,
    originalBytes: preview.originalBytes,
    displayedBytes: preview.displayedBytes,
  }
}

function truncateUtf8WithNotice(text: string, limitBytes: number) {
  const originalBytes = Buffer.byteLength(text, "utf8")
  if (originalBytes <= limitBytes) {
    return {
      text,
      truncated: false,
      originalBytes,
      displayedBytes: originalBytes,
    }
  }

  const notice = `\n[Patch Preview truncated after ${limitBytes} bytes.]`
  const noticeBytes = Buffer.byteLength(notice, "utf8")
  const bodyLimit = Math.max(0, limitBytes - noticeBytes)
  let body = Buffer.from(text, "utf8").subarray(0, bodyLimit).toString("utf8")
  let truncatedText = `${body}${notice}`

  while (Buffer.byteLength(truncatedText, "utf8") > limitBytes && body.length > 0) {
    body = body.slice(0, -1)
    truncatedText = `${body}${notice}`
  }

  return {
    text: truncatedText,
    truncated: true,
    originalBytes,
    displayedBytes: Buffer.byteLength(truncatedText, "utf8"),
  }
}
