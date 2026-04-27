# Desktop Visual Harness

This document describes the desktop renderer visual harness for states that are hard to hold open through the real runtime.

## Purpose

The harness exists to make long-running desktop UI states stable enough to inspect visually. Use it when changing layout, spacing, opacity, sticky-bottom behavior, or interaction states around:

- fallback thinking
- live reasoning
- active tool calls
- waiting-permission cards
- queued runs
- locked composer and footer status

The harness is a development aid. It does not replace runtime tests, desktop source tests, or browser verification against the real app path.

## Entry Point

Run the desktop Vite app and open:

```text
http://127.0.0.1:4173/?fixture=running-states
```

The entry point is local-dev only. It is guarded to the Vite desktop dev server on port `4173`, and it does not call the app-server.

## Scenarios

The harness currently exposes these fixed scenarios:

- `Thinking`: active run with no visible reasoning part and no pending tool call, so the fallback thinking indicator stays visible.
- `Reasoning stream`: active run with a live reasoning part.
- `Running tool`: active run with a pending tool call.
- `Waiting permission`: active run suspended on a pending permission request.
- `Queued`: queued run before streaming begins.

Each scenario uses a long transcript so content scrolls behind the composer area. This is intentional: it lets visual checks catch leaks around composer opacity, footer background, transcript width, bottom inset, and thinking placement.

## When To Use It

Use this harness before and after desktop UI changes that affect:

- `ChatArea`
- `Message`
- `VirtualTranscript`
- permission request cards
- run status indicators
- composer layout, opacity, or footer spacing
- transcript bottom inset or sticky-bottom behavior

For changes that touch the real runtime, still verify the normal app path in addition to the harness.

## Browser Verification

When verifying through browser-use:

1. Open `http://127.0.0.1:4173/?fixture=running-states`.
2. Capture the initial `Thinking` state.
3. Click through `Reasoning stream`, `Running tool`, `Waiting permission`, and `Queued`.
4. Check the browser console for errors.
5. Inspect the bottom composer area while each state is active.

Pay particular attention to:

- transcript text not showing through the composer
- transcript text not leaking at the composer sides
- footer/status text sitting on an opaque background
- thinking/reasoning/tool UI not being hidden by the input area
- scroll-to-bottom affordance staying clear of the composer

## Implementation

The harness lives in:

```text
src/desktop/src/DesktopRunningStatesHarness.tsx
```

The dev-only routing hook lives in:

```text
src/desktop/src/App.tsx
```

Coverage lives in:

```text
test/desktop/running-states-harness.test.tsx
```

The harness should keep using the normal desktop components instead of test-only copies. That keeps the fixture useful for real regressions while avoiding app-server dependency and model latency.

## Adding A Scenario

When adding a new maintained visual state:

1. Add a new `RunningFixtureKind`.
2. Add the scenario label and description to `FIXTURE_KINDS`.
3. Extend `createRunningFixture`, `createTranscript`, or `createActiveAssistantMessage` as needed.
4. Update `test/desktop/running-states-harness.test.tsx` so the scenario remains discoverable.
5. Verify in browser-use on `?fixture=running-states`.

Keep fixture data deterministic. Do not add network calls, timers, app-server calls, or model calls to the harness.

## Commands

Targeted checks:

```bash
bun test test/desktop/running-states-harness.test.tsx
cd src/desktop && bun run check
```

Broader desktop checks:

```bash
bun test test/desktop
cd src/desktop && bun run check
```
