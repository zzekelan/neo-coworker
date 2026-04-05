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

## Extended investigation log

### Phase 1 – Initial triage (10:18 - 10:25 UTC)

- Alert triggered at 10:18 UTC with error rate crossing 5% on the primary API gateway.
- On-call engineer began rollback of deploy 1442 at 10:18:30 UTC.
- Traffic shifted back to release 1441 containers within 90 seconds.
- Error rate dropped from 7.0% to 0.4% by 10:21 UTC.
- The deploy pipeline was paused to prevent automatic progression to the next stage.
- Slack thread #incident-1442 was opened with initial context and dashboard links.
- The on-call engineer confirmed that no customer data was lost during the spike.
- Database metrics showed a brief connection pool exhaustion event at 10:19 UTC.
- The pool recovered after rollback without manual intervention.
- Provider-side metrics showed elevated 429 responses between 10:17 and 10:20 UTC.

### Phase 2 – Root cause investigation (10:25 - 11:00 UTC)

- Code diff between 1441 and 1442 touched three files: provider-response.ts, retry-policy.ts, and db-pool.ts.
- provider-response.ts: removed a null check on providerResponse.id that was guarding against empty streaming chunks.
- retry-policy.ts: added exponential backoff for HTTP 429 with a base delay of 200ms and max 5 retries.
- db-pool.ts: increased max connections from 20 to 50 but did not update the idle timeout accordingly.
- The null check removal caused unhandled exceptions when the provider sent empty keep-alive frames.
- Each unhandled exception leaked a database connection from the pool.
- With max connections raised to 50, the leak was slower to manifest but eventually exhausted the pool.
- The exponential backoff change was correct in isolation but amplified the problem by holding connections longer.
- Event stream reconnection logic in event-stream.ts was not changed but was affected by the pool exhaustion.
- When connections were unavailable, reconnects failed silently and queued duplicate delivery attempts.
- The duplicate delivery was not caught by existing tests because event-stream.test.ts only covered happy-path reconnects.
- A new test was drafted to verify that duplicate events are rejected when replay protection is active.

### Phase 3 – Remediation planning (11:00 - 11:30 UTC)

- Fix 1: restore the null check in provider-response.ts and add a unit test for empty streaming chunks.
- Fix 2: set the idle timeout in db-pool.ts proportional to the new max connection limit.
- Fix 3: add a circuit breaker around the retry loop in retry-policy.ts to cap total connection hold time.
- Fix 4: add a regression test in event-stream.test.ts for duplicate delivery under pool exhaustion.
- Fix 5: add a smoke test for provider throttling that runs against a staged credential set.
- All five fixes must pass CI before the deploy pipeline is unpaused.
- The rollout checklist must be re-signed by the on-call engineer and the team lead.
- A post-incident review is scheduled for the next business day.

### Phase 4 – Verification and monitoring (post-fix)

- After applying the five fixes locally, the full test suite passed in 4 minutes 12 seconds.
- The staged throttling smoke test completed successfully with 0 leaked connections.
- The duplicate event regression test correctly failed when replay protection was disabled.
- Database pool metrics in staging showed stable connection counts under sustained load.
- Provider 429 handling showed correct backoff behavior with connection release after each retry.
- The deploy pipeline was unpaused with release 1443 containing all five fixes.
- Release 1443 was deployed to canary at 14:00 UTC with 5% traffic.
- Error rate on canary remained at 0.2% after 30 minutes.
- Traffic was ramped to 25% at 14:30 UTC and 100% at 15:00 UTC.
- Post-deploy monitoring showed no anomalies over the following 24 hours.

## Additional context padding

- The operator should remember that the incident was caused by a combination of three independent changes.
- No single change would have caused the outage alone; it was the interaction between them.
- The null check removal was the trigger, the pool sizing amplified the damage, and the retry policy extended the duration.
- Future deploys should include a connection leak detector in the smoke test suite.
- The event stream duplicate delivery gap should be tracked as a separate follow-up item.
- The rollout checklist should include a pool metrics review step before any deploy that touches connection settings.
- The on-call runbook should be updated with the connection pool exhaustion recovery procedure.
- The provider throttling smoke test should be added to the pre-deploy gate.
- The post-incident review should cover the interaction between independent changes.
- The operator should remember that the incident was caused by a combination of three independent changes.
- No single change would have caused the outage alone; it was the interaction between them.
- The null check removal was the trigger, the pool sizing amplified the damage, and the retry policy extended the duration.
- Future deploys should include a connection leak detector in the smoke test suite.
- The event stream duplicate delivery gap should be tracked as a separate follow-up item.
- The rollout checklist should include a pool metrics review step before any deploy that touches connection settings.
- The on-call runbook should be updated with the connection pool exhaustion recovery procedure.
- The provider throttling smoke test should be added to the pre-deploy gate.
- The post-incident review should cover the interaction between independent changes.
- The operator should remember that the incident was caused by a combination of three independent changes.
- No single change would have caused the outage alone; it was the interaction between them.
- The null check removal was the trigger, the pool sizing amplified the damage, and the retry policy extended the duration.
- Future deploys should include a connection leak detector in the smoke test suite.
- The event stream duplicate delivery gap should be tracked as a separate follow-up item.
- The rollout checklist should include a pool metrics review step before any deploy that touches connection settings.
- The on-call runbook should be updated with the connection pool exhaustion recovery procedure.
- The provider throttling smoke test should be added to the pre-deploy gate.
- The post-incident review should cover the interaction between independent changes.
