# Use apply_patch as the primary file mutation surface

Neo will replace the anchored `edit` workflow with an opencode-style `apply_patch({ patchText })` tool as the primary file mutation surface. Patch text uses the Codex/opencode envelope and supports add, update, delete, and move operations; `edit` is not registered, while `write` remains temporarily available until `apply_patch` coverage is proven.

Patch approval keeps durable summary details but does not persist full source diffs in permission state; active runs may carry a bounded patch preview for approval, and tool results return a bounded diff preview for model feedback. Shell `apply_patch` invocations are rejected with guidance to use the JSON tool so file mutation stays on the explicit permissioned path.
