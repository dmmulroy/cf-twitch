# Durable workflow state and cutover gate

## State ownership

The Effect implementation retains `saga_runs` and `saga_steps`. New runs have a `workflow_format` version-1 marker. The marker is **not** backfilled for historical runs. A missing marker prevents execution and alarm restoration with `WorkflowError` operation `legacy-state-gate`. Historical SQL remains untouched and status is readable. Legacy Agent JSON contains only `retryScheduleId` and `retryDueAt`, with callbacks in the separate schedules table; it is scheduling evidence rather than the source of business progress.

Before routing production work here, complete the [work-disposition gate](../../../../../docs/production-cutover.md#2-work-disposition). That procedure owns drain/translation approval and ambiguous terminal outcomes; the representation requirements below define what translation must preserve.

The former saga object name was the redemption/message identity, but persisted saga IDs, pending song-request event IDs, raffle roll IDs, and emitted event derivation used the physical DO ID (`ctx.id.toString()`). New SQL uses the explicit redemption ID (raid: EventSub message ID). A translator must preserve the physical-ID-to-redemption mapping, original event UUID, original random outcomes, record-status evidence, result/undo payloads, attempts, and retry due times. Recreating raffle results by redemption ID would generate another roll and is forbidden. The new raffle service's tombstones prohibit late compensated replay from resurrecting ranking rows.

New raffle workflows use the raffle authority's atomic `getOrCreateRoll`, replacing two local random-number checkpoints with one remotely idempotent receipt. This is not a license to translate legacy `generate-winning-number` or `generate-user-roll` evidence by dropping it.

Native EventSub state lives at storage key `eventsub-receipt`. New server startup detects this key and blocks adoption. The historical object does not retain exact signed raw bytes/digest; reconstructing JSON would lose the authenticated-content identity. Drain it before cutover or implement an explicit reviewed translation/disposition. Historical `sending` chat must become `uncertain`, never resent. No namespace transfer or adoption is configured here.

## New execution guarantees

- Inputs are schema-encoded once. Exact duplicates resume; changed direct workflow input conflicts rather than replacing original parameters (a deliberate strengthening of the baseline's original-input-wins behavior).
- Result and undo JSON are parsed on every replay. Corruption prevents effect execution and compensation.
- Prepared intent is committed before wake-up scheduling. Dispatch consumes an attempt and clears safe-to-dispatch retry evidence immediately before external work. Watchdog scheduling failure therefore does not invent an unknown external outcome. Pending non-idempotent dispatched work with no confirmed local outcome becomes `OUTCOME_UNKNOWN` on recovery; no blind retry or refund.
- One execution permit serializes start/alarm calls per object. Baseline ten-second budgets apply to persistence, chat, raid and publication; lookup/Spotify mutation/fulfillment use thirty seconds. Every unfinished run retains a native watchdog alarm; retry timestamps persist before alarm scheduling.
- Fulfillment success and the point-of-no-return marker commit in one SQL transaction. Unknown fulfillment outcomes are conservatively held rather than refunded. Required publication exhausts into `POST_COMMIT_FAILED` without compensation.
- Known-key undo intents persist before queue/raffle HTTP mutations, so remote commit followed by a lost response still requires cleanup before refund. Downstream missing-row deletion tombstones prevent late in-flight creation from resurrecting compensated state. Compensations persist independently and execute in reverse order. Spotify removal must be confirmed before attribution deletion and refund. Multiple matching Spotify occurrences cannot be safely identified by track ID, so the provider fails closed. Unknown removal is not retried; unconfirmed removal exhausts at five attempts without claiming refund.
- Domain event UUIDs retain SHA-256 derivation using `cf-twitch:saga-event:` with the new explicit run identity. Event payload and source timestamp persist before publication; retries use the identical event.
- Best-effort chat delivery is at most once for ambiguous/interrupted outcomes; known rate-limit refusals may retry within the persisted budget.
- Lifecycle and delivery analytics are durably claimed before best-effort ingestion. This avoids duplicate metrics but permits loss if the process stops after claiming and before ingestion. Metrics are not business completion evidence.

## EventSub inbox

The SQL receipt is persisted before dispatch, even if initial alarm scheduling fails. Duplicate identity uses the exact signed-content SHA-256 digest plus message type and subscription type/version; retry/correlation metadata and server `receivedAt` are excluded. First ingestion time is retained; signed header time remains authoritative for offline, raid and chat dispatch ordering. Conflicting content is a typed conflict. Dispatch has a SQL generation-fenced 60-second lease, 45-second operation deadline, and 20 total persisted attempts. Prepared command responses persist separately from sending intent. Restart after sending converts to uncertain after lease expiry, without re-preparation or resend. Definite provider refusal retains the prepared response and respects provider retry delay.

## Service boundaries

`WorkflowJournal` owns checkpoint/retry authority shared by the three orchestrations. `WorkflowExecution` owns compensation and fulfillment policy shared by HTTP start and alarms; `WorkflowAlarm` owns native alarm interop. `EventSubInbox` owns SQL/leases/sending, while `EventSubDispatch` owns notification translation and cross-feature routing. Keep those authorities separate so authentication/dispatch and persistence policy remain independently testable. [Architecture](../../../../../docs/architecture.md#composition-and-lifetime) owns HTTP client lifetime and Layer composition conventions.

## Verification boundary

[Journal tests](workflow-journal.test.ts), [execution tests](workflow-execution.test.ts), and [inbox tests](../eventsub/eventsub-inbox.test.ts) use real SQLite, public services, controlled providers, Effect interruption and TestClock. SQL triggers exercise commit gaps; reconstruction uses fresh Layers over the same database. [Cross-capability regressions](../../../test/review/commands-workflow-review.test.ts) cover remote commit/response loss.

Use the [verification procedure](../../../../../docs/verification.md) to choose and run checks. The [acceptance ledger](../../../../../docs/capability-parity.md#outstanding-native-acceptance) tracks the additional native restart/fault journeys; SQLite reconstruction is not evidence of workerd eviction recovery.
