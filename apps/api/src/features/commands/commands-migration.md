# Commands state and delivery compatibility

## Authority and transport

`Commands` owns definitions, shared values, counters, reference validation and mutation receipts. Its SQL implementation runs only inside the inner Alchemy Durable Object Effect. `CommandsServer` retains physical class **CommandsDO**, and its HTTP client selects singleton **commands**. The `/v1` API is internal to that namespace; Worker HTTP handlers own administrator authentication and preserve public response envelopes.

`ChatCommandExecutor.prepare` interprets verified chat text, checks read permissions, applies runtime handler definitions, and returns either an ignored result or a prepared response. It never sends chat or mutates Spotify. The `song` command reports current playback even when an argument is supplied, matching the baseline despite its historical default description.

## SQL adoption gate

The first runtime acquisition creates `commands_snapshot` through `SqliteMigrator`, then imports `cf_agents_state.state` where `id = 'cf_state_row_id'` if the new snapshot does not yet exist. The original table and row are never modified.

The snapshot preserves:

- `revision` and all runtime `commandsByName` entries;
- `valuesByName`, including attribution and update timestamps;
- `countersByName`, including update timestamps;
- `mutationReceiptsByOperationId`, including original fingerprints and resulting counts;
- `appliedMigrations`, including unknown future/other historical IDs.

Only known deprecated `legacyImportCompleted` and `migrationReport` metadata is discarded. Older snapshots may omit receipts and migration IDs, matching baseline defaults. Malformed JSON, invalid field variants/timestamps, conflicting aliases, missing reference targets, or orphan values/counters fail initialization. Failure does **not** reset state or fall back to defaults. Existing new-format snapshots receive the same validation before traffic.

A transaction combines import, initial bootstrap when truly uninitialized, and outstanding additive default migrations. Already applied IDs are skipped. Missing additive migrations never overwrite an existing canonical name or alias. Deleting every command does not re-bootstrap because the revision remains positive. Source deletion recursively deletes dependent definitions and prunes unreferenced values/counters in one transaction.

A single SQL snapshot is intentional: the baseline's authority is an atomic reference graph, not independently mutable command rows. This keeps historical receipt ordering and runtime definitions intact while moving concurrency and durability to Effect SQL. No legacy module is imported. A future normalized-table migration must preserve the same whole-graph transaction semantics.

## Replay and permissions

Update and counter fingerprints preserve baseline JSON key order and content, so imported receipts remain usable. The EventSub message ID is passed as `operationId`. Equal replay returns the original result without changing revision or overwriting a later value. Reuse with different input or mutation kind fails. New successful mutations retain the latest **5,000** receipt entries. The oldest evicted ID can execute again by design, matching the historical bounded guarantee.

A new dynamic-value mutation resolves current durable metadata and checks its current write permission inside the transaction. A matching receipt replay is already-completed work, not a new write, so it does not re-authorize or change state. Read and write permission hierarchy is broadcaster > moderator > VIP > everyone; subscription badges confer no extra privilege.

## Delivery ownership

Preparation enforces **500 Unicode code points**, after placeholder and output-template expansion. Oversized responses fail instead of truncating or splitting. Stored values retain their independent 2,000 UTF-16-unit validation bound.

The EventSub receipt owner persists the prepared response and a sending intent before Twitch I/O. It must not resend an uncertain outcome. Command preparation alone cannot guarantee exactly-once chat delivery. Preparation records ignored/error analytics; the receipt owner records confirmed-send success or send failure. Re-preparing a mutation is safe only within the bounded receipt window. Persisting the actual prepared response also avoids regenerating time/random-emote responses on delivery retry.

## Verification and cutover limits

[Registry tests](commands-database.test.ts) exercise real SQLite imports/transactions, reference handling, permission changes, malformed-state rejection, imported receipts and the bounded dedupe window. [HTTP API tests](commands-http-api.test.ts) exercise generated clients/servers; [executor tests](chat-command-executor.test.ts) cover the catalog, Unicode limits, provider fallbacks and stats semantics through controlled services. Use the [focused verification procedure](../../../../../docs/verification.md#focused-feedback) for execution and the [recorded results](../../../../../docs/verification.md#recorded-verification) for dated evidence.

The [production gate](../../../../../docs/production-cutover.md) requires an actual Agent-row snapshot and import evidence before cutover. Historical pre-Agent SQL formats are not imported by this migration because they are outside the supplied baseline state format. Returning to the old Agent implementation after new writes requires exporting the current snapshot back to its representation: the untouched original Agent row is stale after cutover and is **not** a safe automatic rollback source.
