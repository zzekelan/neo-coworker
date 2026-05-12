# Desktop Visual Harness

This document describes the desktop renderer visual harness for states that are hard to hold open through the real runtime.

## Purpose

The harness exists to make long-running desktop UI states stable enough to inspect visually. Use it when changing layout, spacing, opacity, sticky-bottom behavior, or interaction states around:

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

For focused activity-detail behavior, open:

```text
http://127.0.0.1:4173/?fixture=activity-details
```

Both entry points are local-dev only. They are guarded to the Vite desktop dev server on port `4173`, and they do not call the app-server.

## Scenarios

The harness currently exposes these fixed scenarios:

- `Reasoning stream`: active run with a live reasoning part.
- `Running tool`: active run with a pending tool call.
- `Waiting permission`: active run suspended on a pending permission request.
- `Queued`: queued run before streaming begins.

Each scenario uses a long timeline so content scrolls behind the composer area. This is intentional: it lets visual checks catch leaks around composer opacity, footer background, timeline width, bottom inset, and reasoning placement.

The `activity-details` fixture focuses on details that require controlled local state:

- live reasoning content appends over time so the reasoning panel can prove it scrolls to the newest output
- after the deterministic stream finishes, the fixture holds a realistic active tool state before starting the next live reasoning state
- the completed activity between the two reasoning states folds into one summary row, including reasoning and completed tool rows
- expanded completed tool rows include long details that should render with the reasoning-style left rail and internal scrollbar

## When To Use It

Use this harness before and after desktop UI changes that affect:

- `ChatArea`
- `Message`
- `VirtualTimeline`
- permission request cards
- run status indicators
- composer layout, opacity, or footer spacing
- timeline bottom inset or sticky-bottom behavior

For changes that touch the real runtime, still verify the normal app path in addition to the harness.

## Browser Verification

When verifying through browser-use:

1. Open `http://127.0.0.1:4173/?fixture=running-states`.
2. Capture the initial `Reasoning stream` state.
3. Click through `Running tool`, `Waiting permission`, and `Queued`.
4. Check the browser console for errors.
5. Inspect the bottom composer area while each state is active.
6. Open `http://127.0.0.1:4173/?fixture=activity-details`.
7. Watch the reasoning panel while lines append, then confirm the fixture pauses on active tool activity before the next live reasoning block appears.
8. Confirm the completed activity between the old and new reasoning states collapses into one summary row.
9. Expand the completed activity row, then expand the completed tool rows and confirm their detail panels use internal scrolling rather than a separate card style.

Pay particular attention to:

- timeline text not showing through the composer
- timeline text not leaking at the composer sides
- footer/status text sitting on an opaque background
- reasoning/tool UI not being hidden by the input area
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
3. Extend `createRunningFixture`, `createTimeline`, or `createActiveAssistantMessage` as needed.
4. Update `test/desktop/running-states-harness.test.tsx` so the scenario remains discoverable.
5. Verify in browser-use on `?fixture=running-states` or `?fixture=activity-details`, depending on the scenario.

Keep fixture data deterministic. Do not add network calls, app-server calls, or model calls to the harness. Timers are acceptable only for local animation/state-transition fixtures such as `activity-details`.

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
