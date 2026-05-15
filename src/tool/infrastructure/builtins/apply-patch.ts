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
  withSerializedFileMutation,
} from "./mutating-file"

const ApplyPatchArgsSchema = z.object({
  patchText: z.string().trim().min(1, "Patch text must not be empty").describe(
    "Codex/opencode patch text beginning with `*** Begin Patch` and ending with `*** End Patch`. Use this for explicit workspace file mutations.",
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
      "Use `apply_patch` for workspace file mutations. Provide a full patch envelope in `patchText`, with `*** Begin Patch`, one or more file operations, and `*** End Patch`. Do not use shell heredocs or commands to apply patches.",
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
      })

      if (decision.decision !== "allow") {
        throw createToolPermissionDeniedError()
      }

      throwIfToolAborted(value.signal)

      for (const change of plan.changes) {
        await withSerializedFileMutation(change.absolutePath, async () => {
          throwIfToolAborted(value.signal)
          await applyPatchPlan({
            ...plan,
            changes: [change],
            summaries: [plan.summaries.find((summary) => summary.path === change.path) ?? {
              path: change.path,
              operation: change.operation,
              additions: change.additions,
              deletions: change.deletions,
            }],
            totalAdditions: change.additions,
            totalDeletions: change.deletions,
            diff: change.diff,
          }, {
            atomicWrite: input.atomicWrite,
          })
        })
      }

      return {
        output: formatPatchToolResult(plan),
        metadata: {
          files: plan.summaries,
          fileCount: plan.changes.length,
          additions: plan.totalAdditions,
          deletions: plan.totalDeletions,
        },
      }
    },
  }
}
