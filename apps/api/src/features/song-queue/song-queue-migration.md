# Song queue migration and verification

## Ownership and boundaries

- `SongQueue` is the application capability. Workflows persist a `PendingSongRequest` with the redemption ID in the historical `eventId` field; HTTP and commands read through the same capability.
- `SongQueueDatabase` owns SQL representation, atomic playback reconciliation, played history, statistics and durable polling intent. The separate application service owns Spotify observation, freshness, stale fallback and alarm sequencing, keeping provider I/O outside SQL transactions.
- `SongQueueAlarm` owns the Cloudflare alarm resource. One physical alarm serves the persisted refresh and cleanup deadlines. A recording alarm implementation is used in local tests; SQL is never simulated.
- `SongQueueServer` retains physical class `SongQueueDO`; `SongQueueClient` uses singleton key `song-queue`. The client memoizes HTTP acquisition per Alchemy execution, not globally. Provider/configuration requirements remain visible until the Worker composition root.

## Preserved behavior

The [acceptance contract](../../../../../docs/capability-parity.md#song-queue-read-model) owns attribution, playback/history, TTL, ordering and query bounds. During import, preserve the identities supporting those rules. Decreasing repeated upcoming occurrences promotes the oldest previously attributed upcoming occurrence; remaining occurrences keep their identities.

Refresh failure preserves the entire last successful snapshot. Backoff is persisted (15s, 30s, 60s, 120s, 240s, capped at 300s). Successful empty/offline snapshots keep polling so playback discovery does not depend on someone opening an overlay. The persisted counter/deadlines replace a process-local Schedule driver because alarms must survive eviction.

## Historical storage adoption

The additive `song_queue_schema_migrations` migration preserves these tables and their existing rows:

- `pending_requests`
- `spotify_queue_snapshot`
- `request_history`

Both baseline Drizzle revisions are accepted. Missing seen/attribution columns are added, not rebuilt. Existing request/history identities seed `song_queue_receipts`; receipts remain after playback, disappearance, TTL cleanup or compensation so redelivery cannot resurrect a completed request. Compensation arriving before persistence leaves a tombstone.

The pinned baseline `agents@0.9.0` stores Agent JSON in `cf_agents_state.state`, key `cf_state_row_id`. The migration parses that exact row, preserving `lastSyncAt`, refresh/cleanup deadlines and consecutive failures. Opaque schedule IDs are intentionally not copied: they are not domain state. Startup reconstructs missing deadlines and installs one native alarm from SQL intent. With no Agent row, snapshot timestamps hydrate freshness. Historical Agent and Drizzle bookkeeping tables remain untouched for inspection. Malformed Agent JSON blocks startup and rolls back adoption; it is never treated as empty state. The pinned SqliteMigrator represents failed migration execution as a startup defect carrying `MigrationError`.

## Verification

Follow [verification](../../../../../docs/verification.md#focused-feedback) for focused checks and [local workerd operation](../../../../../docs/verification.md#local-workerd-harness) for native acceptance. Dated counts belong in the central verification record.

- [Database tests](song-queue-database.test.ts): real SQLite imports, transactions, rollback/corruption, receipts/tombstones, TTL and statistics.
- [Reconciliation properties](song-queue-reconciliation.test.ts): repeated occurrences, attribution ordering and played-only history.
- [Service tests](song-queue-service.test.ts): provider parsing, stale fallback, concurrency, durable backoff and alarm repair through controlled HTTP.
- [Native scenario](scenario/song-queue-scenario.workerd.ts): actual Worker → execution-scoped client → SongQueueDO → SQL graph with controlled Spotify behavior.

## Cutover limitations

- Worker platform compatibility depends on the [documented Alchemy patch](../../../../../patches/README.md). Its upgrade/removal condition belongs with the patch.
- Native fault coverage and production approval are tracked in the [acceptance ledger](../../../../../docs/capability-parity.md#outstanding-native-acceptance) and [cutover gate](../../../../../docs/production-cutover.md).
- Legacy saga DO-derived request IDs are retained verbatim. New workflows use redemption IDs. Mapping in-flight legacy saga identities is a workflow/cutover concern; do not replay them under new identities without an explicit mapping/drain strategy.
- Polling cannot prove an unobserved track was played, distinguish arbitrary Spotify manual reorder/removal from all same-track transitions, or guarantee attribution when a request appears and finishes entirely between polls. The conservative baseline rule remains: no observed attributed current occurrence, no history.
- Permanent receipt tombstones intentionally trade storage growth for replay safety. Retention requires a separately justified maximum-redelivery policy before pruning.
