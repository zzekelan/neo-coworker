# TOOL MODULE KNOWLEDGE BASE

## OVERVIEW
`src/tool/` owns the runtime tool contract plus builtin tool implementations for workspace I/O, shell access, web fetch/search, and tool registration.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Public tool API | `public/index.ts` | Module exit |
| Execution and registry | `application/execute-service.ts`, `application/registry-service.ts` | Runtime-facing behavior |
| Builtin runtime assembly | `infrastructure/runtime/create-builtin-runtime.ts` | Default tool set and ordering |
| Search providers | `infrastructure/builtins/search-backend.ts` | Exa/public provider parsing hotspot |
| Workspace file visibility | `infrastructure/builtins/workspace-files.ts` | Excludes `.agents/**` and hidden state |
| File mutation tools | `infrastructure/builtins/{write,edit}.ts` | Safe path resolution and permission flow |
| Shell/web tools | `infrastructure/builtins/{shell,webfetch}.ts` | OS/network boundaries |

## CONVENTIONS
- Builtins are infrastructure implementations of the domain `ToolDefinition` contract.
- Validate input with local schemas before touching filesystem, shell, or network.
- Request permission for mutating, shell, and network-sensitive operations.
- Preserve workspace safety: keep path resolution inside the workspace and keep `.agents/**` hidden from normal search flows.
- **Concurrency Classification**: Tools are classified as `read-only` or `mutating`. Read-only tools can run in parallel; mutating tools must run serially.
- **Tool Enhancement Standard**: Every tool must have a rich `description`, use `.describe()` for all parameters in the `inputSchema`, and provide `usageGuidance`.

## NEW TOOLDEFINITION FIELDS
| Field | Type | Description |
|-------|------|-------------|
| `concurrency` | `'read-only' \| 'mutating'` | Classification for parallel execution |
| `isConcurrencySafe(input)` | `(input: unknown) => boolean` | Optional runtime check for safety |
| `usageGuidance` | `string` | Specific instructions for the model on when/how to use |
| `resultSizeLimit` | `number` | Limit in bytes for the tool output |
| `isCompressible` | `boolean` | Whether tool results are safe for micro-compaction |
| `timeout` | `number` | Execution timeout in milliseconds |

## ANTI-PATTERNS
- Do not add a builtin without wiring it through `create-builtin-runtime.ts`.
- Do not bypass permission prompts for tools that cross OS, shell, or network boundaries.
- Do not weaken workspace path guards just to support a corner case.
- Do not leak provider-specific parsing assumptions outside `search-backend.ts`.
- **Avoid Implicit Concurrency**: Do not assume a tool is safe for parallel execution without setting `concurrency: 'read-only'`.

## HOTSPOTS
- `infrastructure/builtins/search-backend.ts` — multi-provider HTTP/SSE parsing and fallback logic.
- `infrastructure/builtins/workspace-files.ts` — `rg` fallback behavior, exclusions, truncation.
- `infrastructure/builtins/shell.ts` — process lifecycle, abort, and forced termination.

## TESTS TO RUN
```bash
bun test test/runtime/tools
bun test test/skill/runtime-api.test.ts
bun run test:structure
```

## CHANGE CHECKLIST
- New builtin: add factory, register it, add runtime-tool tests, and verify permission UX.
- Search backend changes: test provider parsing, timeout behavior, and abort handling.
- File visibility changes: verify `.agents/**` remains hidden unless the product requirement changes explicitly.
