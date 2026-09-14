# Production cutover — blocked until reviewed

Local verification proves neither compatibility with actual production data nor permission to change production resources. Keep the legacy host available until the gates below are approved. The current Stack exposes non-production stages only; enabling production, inventory access, adoption/transfer, deployment, and rollback each require separate operator authorization.

This is an approval procedure, not a deployment script. No production inventory runner is included. Its implementation and authorization require separate review.

## Storage inventory

Use the physical classes and canonical keys in [durable authorities](architecture.md#durable-authorities), not capability-group labels, when identifying resources. Inspect legacy implementation and migrations at baseline commit `8eef994fba90ee9d8af882c712abe5455c13f2dc` with `git show <commit>:<path>` or a read-only checkout.

| Storage authority                                                                      | Required representation reference                                                                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpotifyTokenDO`, `TwitchTokenDO`, `OAuthStateDO`                                      | [Token Agent JSON/schedules and native OAuth state](../apps/api/src/features/providers/provider-migration-notes.md#historical-token-import)                |
| `CommandsDO`                                                                           | [Complete command snapshot, references, and receipts](../apps/api/src/features/commands/commands-migration.md#sql-adoption-gate)                           |
| `SongQueueDO`                                                                          | [Pending/history/snapshot SQL and Agent scheduling metadata](../apps/api/src/features/song-queue/song-queue-migration.md#historical-storage-adoption)      |
| `AchievementsDO`, `KeyboardRaffleDO`                                                   | [Historical SQL, outbox generations, and legacy roll identity](../apps/api/src/features/achievements/rewards-verification.md#historical-state-and-cutover) |
| `SongRequestSagaDO`, `KeyboardRaffleSagaDO`, `RaidShoutoutSagaDO`, `EventSubWebhookDO` | [Workflow checkpoints, format gate, and native EventSub receipts](../apps/api/src/features/workflows/WORKFLOW-MIGRATION.md#state-ownership)                |
| `StreamLifecycleDO`, `EventBusDO`                                                      | [Stream and Event Bus legacy authority](#stream-and-event-bus-legacy-authority)                                                                            |

Account separately for Agent JSON, Agent schedules, native storage/alarms, SQL application tables, and migration metadata. Include malformed records and outstanding work rather than treating them as absent.

### Shared legacy Agent representation

The pinned legacy SDK is `agents@0.9.0`, Cloudflare Agents commit [`806579ac0fc38aeea93ce160731ac5cfd082abfe`](https://github.com/cloudflare/agents/blob/806579ac0fc38aeea93ce160731ac5cfd082abfe/packages/agents/src/index.ts). Its schema is `cf_agents_state(id TEXT PRIMARY KEY NOT NULL, state TEXT)`:

- `cf_state_row_id` contains `JSON.stringify(nextState)`.
- `cf_schema_version` contains text `"2"`; the older `cf_state_was_changed` marker is deleted by that SDK's migration.
- `cf_agents_schedules` is a separate authority. Schedule `time` is Unix **seconds**; an opaque schedule ID is not a deadline.

Inspect raw tables rather than invoking the legacy state getter: that getter replaces malformed JSON with `initialState`. Supported importers retain source tables and validate authority before default writes. Their tests use production-shaped fixtures, not production exports; actual inventory remains required.

### Stream and Event Bus legacy authority

Stream Agent JSON is tagged `OfflineStream`/`LiveStream`, with source timestamps, peak viewer count, viewer poll schedule ID, and optional transition intent. The intent carries Event ID, stream session identity/time, four completion booleans, and its poll schedule ID. An older untagged boolean representation contains `isLive`, `startedAt`, `endedAt`, `peakViewerCount`, `streamSessionId`, and `viewerPollScheduleId`.

Preserve partial transitions and resolve referenced `pollViewerCountTick` schedules from their callback/type/due-time evidence. Current `stream_lifecycle_state` SQL rows use the current codec exclusively. Legacy import selects a representation from its fields; malformed higher-priority evidence cannot fall through to a weaker format. [Stream SQLite tests](../apps/api/src/features/stream/stream-database.test.ts) cover source preservation and rejection before migration writes.

Event Bus Agent JSON contains retry-sweep and DLQ-purge schedule identities/deadlines; pending events, dead letters, and delivered receipts are SQL authority. Preserve attempts, due times, raw corrupt payload evidence, and independent dead-letter retention dates. Rebuild scheduling from durable rows instead of dropping work whose old schedule ID cannot transfer. [Event Bus SQLite tests](../apps/api/src/features/events/event-bus-database.test.ts) cover imports and corruption handling.

## Approval gates

### 1. Inventory

Obtain the separately authorized read-only inventory for every physical namespace. Record the source snapshot identity, representation versions, row/key counts, malformed evidence, and active/ambiguous work. Keep credentials and raw sensitive payloads in access-controlled storage, not logs or review summaries.

**Complete when:** every authority in the inventory table has a recorded result, including explicit empty results; all unreadable or unknown representations are classified as blockers. Missing or unparsable inventory blocks progression.

### 2. Work disposition

Prepare and authorize a maintenance procedure that stops admission of new legacy work. Drain `RUNNING` and `COMPENSATING` sagas through the legacy deployed host, or prove row-level translation of status, attempts, result/undo values, deadlines, point-of-no-return evidence, and schedule ownership.

Record a disposition for every `OUTCOME_UNKNOWN`, `COMPENSATION_FAILED`, and `POST_COMMIT_FAILED` run. Preserve the physical-DO-ID-to-redemption mapping for legacy pending requests, raffle rolls, workflow checkpoints, and event identities. Recreating a draw under a new identity is not translation.

Reconcile native EventSub receipts, including pending/dead-letter work and uncertain chat evidence. Their exact-body digest cannot be reconstructed from parsed JSON, so automatic receipt adoption is blocked. Reconcile Event Bus receipts/attempts/expiry and achievement inbox/progress/unlocks/watermark/outbox generations. Interrupted `sending` announcements remain `uncertain` rather than being resent.

**Complete when:** every outstanding or ambiguous item maps to a reviewed drain result or translation/disposition record, with zero unaccounted IDs; a write-admission boundary keeps that accounting valid.

### 3. Import and recovery evidence

Exercise supported imports against copies of the actual inventory, preserving a recoverable source snapshot. Prove restart safety, idempotence, and failure without destructive default initialization. Run the [verification procedure](verification.md) and assess each remaining [native acceptance gap](capability-parity.md#outstanding-native-acceptance).

**Complete when:** every representation being moved has import/rejection and recovery evidence, required checks pass, and each native journey required by the proposed production traffic has a passing result. Unverified required journeys remain blockers.

### 4. Infrastructure and rollback approval

Review a dry Alchemy plan against the existing Worker, bindings, physical classes, namespace IDs, and historical Cloudflare migration tags `v1`–`v9`. Fresh namespace creation is not adoption. State-backend selection, enabling a production stage, adoption/transfer, and deployment remain separate decisions.

Retained legacy tables are inspection evidence, not an automatic rollback source: they become stale after new writes. Prove a restoration/translation strategy and write-admission boundary before relying on rollback. Keep old namespaces until their retention/disposal decision is separately approved.

**Complete when:** the inventory, work dispositions, required recovery evidence, resource plan, and rollback strategy have explicit operator approval. Passing this documentation gate still does not execute or authorize an unrequested deployment command.
