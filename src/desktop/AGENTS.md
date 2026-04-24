# DESKTOP KNOWLEDGE BASE

## OVERVIEW
`src/desktop/` is a nested package for the Electron shell plus Vite/React renderer. It can run against a managed local app-server or an external server.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Package commands | `package.json` | `dev`, `build`, `check`, `electron` |
| Electron main process | `electron/main.mjs` | Starts UI server, managed local server, IPC bridge |
| Preload bridge | `electron/preload.cjs` | `window.neoCoworkerDesktop` contract |
| Persisted settings/state | `electron/{settings-state,selection-state}.mjs` | Writes `.ncoworker/desktop-*.json` |
| Renderer entry | `src/main.tsx` | Browser-mode shim for non-Electron dev |
| Renderer app | `src/App.tsx`, `src/useDesktopApp.ts` | Main UI orchestration hotspot |
| API/dev proxy | `src/api.ts`, `dev-server-config.ts` | Browser-mode server routing |
| Desktop tests | `../../test/desktop/` | Product-surface verification lives at repo root |

## COMMANDS
```bash
cd src/desktop && bun run dev
cd src/desktop && bun run build
cd src/desktop && bun run check
cd src/desktop && bun run electron
node ./scripts/desktop-user-path-check.mjs
```

## CONVENTIONS
- Browser-mode dev uses a shimmed desktop bridge in `src/main.tsx`; Electron mode uses the preload bridge.
- Managed-local mode starts `src/app-server/main.ts` via Bun and persists desktop state under XDG app data; the default workspace path is repo-root `.ncoworker/workspace` with no `.agents/` fallback.
- `useDesktopApp.ts` is the main orchestration hotspot; keep UI state logic there coherent instead of scattering side effects.
- Dev proxy behavior belongs in `dev-server-config.ts`, not ad hoc in components.
- **Theme System**: CSS-variable-based theme system using Linear-inspired naming (e.g., `--color-paper`, `--color-ink`, `--color-accent`, `--color-surface`).
- **UI Performance**:
  - Use `useVirtualizer` (ResizeObserver-based virtual scrolling) for long lists like the chat transcript.
  - Wrap high-frequency components (`Message`, `ToolIndicator`, `MarkdownText`) in `React.memo`.
  - Use `React.lazy` for heavy components like `MarkdownText` with `Suspense` and pulse placeholders.
- **Accessibility**: Wrap the application in `KeyboardShortcutProvider` for global shortcuts (e.g., Cmd+K for `CommandPalette`).
- **Resilience**: Chat area and individual messages are wrapped in `ErrorBoundary` to prevent total UI failure.
- **Test Pattern**: Desktop tests favor `readFileSync` source analysis for checking React structure (lazy, memo, boundary) without needing DOM APIs in `bun:test`.

## ANTI-PATTERNS
- Do not treat browser-mode shim behavior as equivalent to the real preload bridge without checking Electron.
- Do not commit `.ncoworker/desktop-state.json`, `.ncoworker/desktop-settings.json`, or local server DBs.
- Do not add generic UI patterns that ignore the repo’s frontend-design rules.
- Do not restart the managed local server while active runs still exist.
- Do not perform expensive re-renders in the transcript; use virtual scrolling and memoization.
- Do not use DOM-based testing in `bun:test` for desktop components; use static source analysis.

## TESTS TO RUN
```bash
bun test test/desktop
node ./scripts/desktop-user-path-check.mjs
```

## CHANGE CHECKLIST
- IPC/preload changes: verify both Electron runtime and browser-mode fallback.
- Settings flow changes: verify save/apply/restart behavior and persisted state paths.
- UI state changes: re-run `test/desktop` and keep `useDesktopApp.ts` responsibilities explicit.
