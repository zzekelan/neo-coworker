# context recovery fixture

This file is intentionally verbose so the live compaction evals have enough material to compress.
The operator wants the assistant to keep track of deployment risk, rollback status, and pending checks.

## Incident overview

- Release 1442 increased API error rate from 0.3% to 7.0% within six minutes.
- Traffic rollback started at 10:18 UTC and user-facing errors dropped back to baseline by 10:21 UTC.
- The deploy touched retry handling, provider response parsing, and database pool sizing.
- The operator needs a concise status update before any redeploy is attempted.

## Constraints

- Do not assume the rollback fixed the root cause.
- Keep focus on correctness, regressions, and missing tests before any polish work.
- Treat provider 429 handling, duplicate events, and pool exhaustion as the highest-risk areas.
- Preserve exact file names and operator-facing status markers when summarizing the situation.

## Investigation notes

- provider-response.ts had a null check removed around providerResponse.id.
- retry-policy.ts added exponential backoff for HTTP 429 responses.
- event-stream.test.ts still allows duplicate delivery under reconnect scenarios.
- db-pool.ts still uses the pre-rollback max connection settings.
- dashboard snapshots show recovery, but the rollout checklist is still open.

## Deployment checklist

- Compare the config diff between deploy 1441 and 1442.
- Verify the database pool limits for the worker and API services.
- Confirm duplicate-event tests still fail when replay protection is removed.
- Re-run the provider throttling smoke test with staged credentials.
- Keep the rollback in place until the config diff and pool review are complete.

## Operator summary anchors

- Anchor A: the system recovered after rollback, but redeploy is blocked.
- Anchor B: the next step is to compare config diff and DB pool settings.
- Anchor C: correctness and regression risk matter more than output polish.
- Anchor D: the assistant should remember this file heading exactly when recovery works.

## Repeated context to enlarge the read result

- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
- The operator wants short, concrete answers that keep the focus on what to do next.
- The assistant should remember that rollback success does not prove the deploy is safe.
- The assistant should preserve the relationship between provider retries and database pool pressure.
- The assistant should preserve the relationship between duplicate events and reconnect handling.
- The assistant should preserve the relationship between rollout gates and the operator summary.
