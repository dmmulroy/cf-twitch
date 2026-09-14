# Raffle and achievement verification

## Capability boundaries

- `Raffle` (`../raffle/raffle-service.ts`) owns secure draw creation, immutable roll receipts, active roll history and ranking. `raffleClientLayer` provides that tag over the `KeyboardRaffleDO` HTTP namespace, singleton `keyboard-raffle`.
- `Achievements` (`achievements-service.ts`) owns the transactional Event ID inbox, stable Viewer ID progress, all thirteen definitions, stream watermark/session resets, request streaks, ranking, debug snapshots and one-time resets. `achievementsClientLayer` provides that tag over physical `AchievementsDO`, singleton `achievements`.
- `AchievementOutbox` owns durable metric/chat claims and retry scheduling evidence. It requires the real `TwitchService` and `TwitchAnalytics`; no fallback implementation is installed. The server captures infrastructure in outer initialization and acquires SQL only at runtime.
- `WorkflowExecution` owns raffle fulfillment/refund, raffle chat/event/metric delivery and compensation. Raffle deletion removes the active roll but retains its immutable receipt. A delayed replay does not resurrect it or draw again.

Raffle randomness/history, achievement progression/session transactions, and non-idempotent outbox claims have separate authorities. HTTP clients expose those same application interfaces; [architecture](../../../../../docs/architecture.md) owns invocation-lifetime and Layer conventions.

## Historical state and cutover

Frozen full baseline migration statements live in `achievements-historical.fixture.ts` and `../raffle/raffle-historical.fixture.ts`. Real SQLite tests construct those historical schemas independently of the new migration loaders, seed state, then acquire the new production SQL Layers. These are SQL adoption tests, not a production namespace transfer.

Preserved achievement tables: `achievement_definitions`, `user_achievements`, `user_streaks`, `event_history`, `achievement_stream_session`, `achievement_unlock_outbox`. Preserved raffle tables/view: `rolls`, `raffle_leaderboard`. Agent JSON is not an authoritative migration source. Existing sending announcements become uncertain on SQL authority startup; claimed metrics stay claimed. No old Agent queue or schedule callbacks are imported.

Additive tables: `raffle_roll_receipts` retains immutable evidence through compensation; `raffle_compensated_rolls` fences deletion before the first receipt commit (subsequent creation returns typed `compensated` without generating entropy); `achievement_outbox_retry` persists retry instants; `achievement_current_unlock` fences an old in-flight chat response from marking a later unlock as announced. Effect migration journals are separate from historical Drizzle journals.

Pre-baseline achievement schemas without Viewer ID/announcement-state columns and pre-baseline raffle schemas without persisted record evidence are intentionally unsupported and fail closed. No automatic name-to-Viewer-ID reconciliation is attempted. Foundation schemas can reject invalid historical IDs/timestamps; corrupt rows remain visible as typed failures rather than silently disappearing.

**Active legacy raffle workflow cutover is blocked without identity mapping.** Baseline raffle sagas stored `rolls.id = this.ctx.id.toString()` (physical saga DO ID), not the redemption ID. Historical roll replay remains supported by its existing ID; a new redemption-ID workflow must not generate another roll for an already recorded legacy saga. The [workflow format gate](../workflows/WORKFLOW-MIGRATION.md#state-ownership) requires preserving that mapping/checkpoint before adoption.

Behavioral corrections are explicit: Stream Opener requires the current request source timestamp to be strictly after session start (the baseline only filtered prior requests); watermark comparisons use instants across timezone offsets. Winners/ties never produce a new closest record. Administrative resets abandon stale announcements. Unknown Twitch chat outcomes are never retried; only definite preflight/refusal failures are eligible for the persisted 3/5/10-second retry schedule, respecting a longer provider retry-after.

## Verification

Use the [focused verification command](../../../../../docs/verification.md#focused-feedback) with `src/features/raffle src/features/achievements`. Dated run results belong in [recorded verification](../../../../../docs/verification.md#recorded-verification).

Evidence entrypoints: [raffle SQL](../raffle/raffle-database.test.ts), [raffle migration](../raffle/raffle-migration.test.ts), [achievement SQL](achievements-database.test.ts), [historical migration](achievement-migration.test.ts), [rules](achievement-rules.test.ts), and [outbox](achievement-outbox.test.ts). They cover:

- Real SQLite: immutable exact replay/conflict, concurrent draw deduplication, compensation receipt retention, global strict record rules, all ranking modes, latest display names, SQL constraints and receipt transaction rollback.
- Real SQLite: all thirteen definitions and unlocks, threshold freeze, one-time progress, streak replacement/reset/longest retention, concurrent Event ID inbox, stable Viewer ID rename, strictly-after Stream Opener, stale/mismatched stream transitions, ranking/unannounced/debug/reset, outbox transaction rollback, direct event compatibility and corrupt definition errors.
- Independent frozen historical SQL adoption, complete state rehydration and sending-to-uncertain recovery.
- Actual `AchievementOutbox.flush` with real SQLite, the complete production Twitch HTTP service over the closed controlled provider transport, and recording analytics: all thirteen announcements/metrics, concurrent exactly-once claims, durable rate-limit deadlines/Retry-After/retry exhaustion, dropped chat abandonment, unknown/malformed delivery non-retry, replay/restart metric deduplication. A SQLite trigger rejects finalization after an actual successful provider response; SQL authority restart changes sending to uncertain and subsequent calls do not send another chat or metric.
- Real Effect HTTP handlers: valid JSON roundtrips, versioned intake/query/reset, invalid bounded inputs and rejection of caller-supplied raffle derived evidence.
- FastCheck properties: threshold/streak laws, equivalent-instant watermark ordering, unknown-outcome non-retry, bounded announcement retries and Retry-After precedence; generated real-SQL roll pairs/redelivery permutations. Web Crypto draw bounds are tested without claiming that a finite statistical test proves cryptographic uniformity. The implementation uses Uint32 rejection sampling, never modulo reduction of an incomplete bucket.

## Native recovery and polling trade-off

Before treating application outbox tests as native recovery evidence, check the [outstanding acceptance journeys](../../../../../docs/capability-parity.md#outstanding-native-acceptance). That ledger owns the native alarm/process-restart gaps.

The outbox's one-second alarm polling honors durable retry instants and stops on the next empty pass. It prioritizes recoverability over precise sub-second scheduling; provider rate-limit delays can cause repeated empty polling passes. Cloudflare alarm timing is not exact. Old pre-outbox unlocks remain visible through `getUnannounced`; no speculative chat intents are fabricated for them.
