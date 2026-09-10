# Capability parity and acceptance

Baseline: `8eef994fba90ee9d8af882c712abe5455c13f2dc`. This ledger preserves the historical public contract and required behavior independently of current implementation. Explicit replacement decisions are called out where internal mechanisms differ.

## Acceptance status

**Local verification passed; production cutover remains blocked.** The dated run results live in [recorded verification](verification.md#recorded-verification). Actual production inventory, outstanding-work disposition, and native restart/fault evidence are still required by the [production gate](production-cutover.md).

Read only the capability being changed. The evidence links below identify concrete test entrypoints, not complete branch coverage or proof that every requirement has been demonstrated under native workerd. A requirement is complete only when its observable behavior and failure semantics have evidence at the required interface; preserve unresolved journeys in [outstanding native acceptance](#outstanding-native-acceptance).

| Requirement branch                                      | Existing evidence                                                                                                                                                                                                                                                                      | Native evidence limit                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Public HTTP](#worker-http-contract)                    | [HTTP envelopes/security][http], [administrator SQLite handlers][admin], [response cache](../apps/api/src/features/http/http-response-cache.test.ts)                                                                                                                                   | [Full Worker journey][native] exercises representative routes, not every HTTP failure                                                                               |
| [OAuth/providers](#providers-and-oauth)                 | [OAuth HTTP][oauth], [token lifecycle](../apps/api/src/features/providers/provider-token-lifecycle.test.ts), [token migration](../apps/api/src/features/providers/provider-token-migration.test.ts)                                                                                    | [Native OAuth/full Worker][native] cover one-use state, expiry alarm, both providers, and concurrent refresh; no forced eviction during rotation                    |
| [EventSub](#eventsub-acceptance-and-dispatch)           | [Signed HTTP][webhook], [message parsing](../apps/api/src/features/eventsub/eventsub-message.test.ts), [durable inbox](../apps/api/src/features/eventsub/eventsub-inbox.test.ts)                                                                                                       | [Full Worker][native] covers signed notifications, redelivery and alarm dispatch; fault matrix remains incomplete                                                   |
| [Song Request workflow](#song-request-workflow)         | [Execution/compensation](../apps/api/src/features/workflows/workflow-execution.test.ts), [remote commit/response loss](../apps/api/test/review/commands-workflow-review.test.ts)                                                                                                       | [Full Worker][native] covers acceptance, one queue mutation and fulfillment; native fault/restart journeys remain                                                   |
| [Song Queue](#song-queue-read-model)                    | [SQL](../apps/api/src/features/song-queue/song-queue-database.test.ts), [occurrence properties](../apps/api/src/features/song-queue/song-queue-reconciliation.test.ts), [service](../apps/api/src/features/song-queue/song-queue-service.test.ts)                                      | [Worker-to-DO scenario](../apps/api/src/features/song-queue/scenario/song-queue-scenario.workerd.ts) covers native HTTP/SQL, not the complete playback/fault matrix |
| [Raffle](#keyboard-raffle)                              | [SQL/receipt invariants](../apps/api/src/features/raffle/raffle-database.test.ts), [historical import](../apps/api/src/features/raffle/raffle-migration.test.ts), [workflow uncertainty](../apps/api/test/review/commands-workflow-review.test.ts)                                     | [Full Worker][native] covers a signed raffle; native commit-loss and restart journeys remain                                                                        |
| [Achievements](#achievements)                           | [SQL](../apps/api/src/features/achievements/achievements-database.test.ts), [rules](../apps/api/src/features/achievements/achievement-rules.test.ts), [outbox](../apps/api/src/features/achievements/achievement-outbox.test.ts)                                                       | [Full Worker][native] proves `first_request` unlock, not all definitions or native announcement recovery                                                            |
| [Chat Commands](#chat-commands)                         | [Registry](../apps/api/src/features/commands/commands-database.test.ts), [executor](../apps/api/src/features/commands/chat-command-executor.test.ts), [interrupted delivery](../apps/api/test/review/commands-eventsub-review.test.ts)                                                 | [Full Worker][native] covers administration and idempotent signed `!skillissue`; native send-interruption remains                                                   |
| [Stream](#stream-lifecycle) and [Event Bus](#event-bus) | [Stream migration](../apps/api/src/features/stream/stream-database.test.ts), [lifecycle](../apps/api/src/features/stream/stream.test.ts), [event delivery](../apps/api/src/features/events/event-bus.test.ts), [event SQL](../apps/api/src/features/events/event-bus-database.test.ts) | [Full Worker][native] covers online/offline and achievement delivery, not each checkpoint restart                                                                   |
| [Workflow recovery](#workflow-and-raid-recovery)        | [Journal](../apps/api/src/features/workflows/workflow-journal.test.ts), [execution](../apps/api/src/features/workflows/workflow-execution.test.ts)                                                                                                                                     | [Full Worker][native] covers raid intake; arbitrary native eviction remains unverified                                                                              |

## Worker HTTP contract

Keep public URLs and envelopes compatible. Unexpected application failures stay behind safe public errors; every response retains server-owned `x-request-id` and `x-trace-id`. The current generated route inventory comes from `pnpm inspect:api`; it does not replace these frozen expectations.

| Method and path                                | Authentication / input                               | Expected success                                                         | Compatibility failures                                                                                                  | HTTP evidence       |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `GET /health`                                  | None                                                 | `200 {"status":"ok"}`                                                    | Invalid startup configuration returns service unavailable before normal routing                                         | [HTTP][http]        |
| `GET /api/now-playing`                         | None                                                 | `{track, position:0}`, nullable attributed/autoplay track                | Queue transport `503`; other failure `500`                                                                              | [HTTP][http]        |
| `GET /api/queue`                               | Strict limit, default 10, 1–100                      | `{tracks,totalCount}`                                                    | Invalid/unknown query `400`; unavailable `503`                                                                          | [HTTP][http]        |
| `GET /api/song-requests/history`               | Strict limit, default 10, 1–100                      | Newest played requests and total count                                   | Invalid query `400`; unavailable `503`                                                                                  | [HTTP][http]        |
| `GET /api/achievements/definitions`            | None                                                 | All 13 definitions                                                       | Read failure `500`                                                                                                      | [HTTP][http]        |
| `GET /api/achievements/leaderboard`            | Strict limit, default 10, 1–100                      | Viewers ranked by unlock count                                           | Invalid query `400`; read failure `500`                                                                                 | [HTTP][http]        |
| `GET /api/achievements/:user`                  | Display-name path                                    | All definitions with viewer progress/unlocks                             | Read failure `500`                                                                                                      | [HTTP][http]        |
| `GET /api/achievements/:user/unlocked`         | Display-name path                                    | Unlocked definitions, newest first                                       | Read failure `500`                                                                                                      | [HTTP][http]        |
| `GET /api/stats/top-tracks`                    | Strict limit, default 10, 1–100                      | Played requests grouped by Track ID                                      | Invalid query `400`; unavailable `503`; invalid owner response `502`                                                    | [HTTP][http]        |
| `GET /api/stats/top-tracks/:user`              | Numeric Viewer ID, 1–20 digits; strict limit         | Per-viewer top tracks                                                    | Invalid path/query `400`; same provider failure projection                                                              | [HTTP][http]        |
| `GET /api/stats/top-requesters`                | Strict limit                                         | Stable Viewer IDs, latest display names                                  | Same as top tracks                                                                                                      | [HTTP][http]        |
| `GET /api/stats/raffle/leaderboard`            | Strict limit; sort `rolls`, `wins`, or `closest`     | Bounded leaderboard                                                      | Invalid query `400`; unavailable `503`; invalid response `502`                                                          | [HTTP][http]        |
| `GET /api/stats/raffle/user/:user`             | Numeric Viewer ID, no query keys                     | Viewer aggregate                                                         | No roll `404`; invalid input `400`; unavailable `503`                                                                   | [HTTP][http]        |
| `GET /overlay/now-playing`                     | None                                                 | Transparent OBS HTML                                                     | Provider/user content cannot become executable HTML                                                                     | [HTTP][http]        |
| `GET /oauth/spotify/authorize`                 | Exact `x-setup-secret`                               | `302` with state, redirect URI and playback scopes                       | Query secret `401`; missing setup config fails closed                                                                   | [OAuth][oauth]      |
| `GET /oauth/twitch/authorize`                  | Exact `x-setup-secret`                               | `302` with redemption/chat/shoutout scopes                               | Same as Spotify authorization                                                                                           | [OAuth][oauth]      |
| `GET /oauth/{spotify,twitch}/callback`         | Provider state; code or error                        | Exchange, durable token acceptance, completion `200`                     | Missing/invalid/expired/consumed/mismatched state `400`; state-store failure `503`; malformed provider success rejected | [OAuth][oauth]      |
| `POST /eventsub/setup`                         | Administrator bearer                                 | Creates five required subscriptions; skips matching enabled/pending ones | Partial create `500` with created/skipped/errors                                                                        | [EventSub][webhook] |
| `GET /eventsub/list`                           | Administrator bearer                                 | Complete paginated list and total                                        | Provider/parse failure `500`; bounded 100-page traversal                                                                | [EventSub][webhook] |
| `DELETE /eventsub/:id`                         | Administrator bearer                                 | URL-encoded deletion                                                     | Provider failure `500`                                                                                                  | [EventSub][webhook] |
| `POST /eventsub/cleanup`                       | Administrator bearer                                 | Attempts every listed deletion                                           | Partial result remains `200`, `success:false`                                                                           | [EventSub][webhook] |
| `POST /webhooks/twitch`                        | Exact signed request                                 | Challenge or `200 {success:true}` after durable acceptance               | See signed-boundary ordering below                                                                                      | [EventSub][webhook] |
| `GET /api/debug/stream-state`                  | Administrator bearer                                 | Current lifecycle state                                                  | Read failure `500`                                                                                                      | [HTTP][http]        |
| `GET /api/debug/keyboard-raffle/leaderboard`   | Administrator bearer; strict sort/limit              | Leaderboard                                                              | Invalid query `400`                                                                                                     | [HTTP][http]        |
| `POST /api/debug/reconcile-stream-state`       | Administrator bearer                                 | `{action,queueWarmup,before,after,twitch}`                               | Invalid Twitch timestamp `502`; state/effect failure `500`                                                              | [HTTP][http]        |
| `GET /api/debug/status`                        | Administrator bearer                                 | Partial aggregate with per-component status/errors                       | Partial dependency failure still returns aggregate                                                                      | [HTTP][http]        |
| `GET /api/admin/dlq`                           | Administrator bearer; limit ≤100, nonnegative offset | Paginated dead letters                                                   | Invalid query `400`; read failure `500`                                                                                 | [Admin][admin]      |
| `GET /api/admin/event-bus/pending`             | Same                                                 | Paginated pending events                                                 | Same                                                                                                                    | [Admin][admin]      |
| `POST /api/admin/dlq/:id/replay`               | Administrator bearer                                 | Success or honest `success:false`                                        | Missing `404`; persistence failure `500`                                                                                | [Admin][admin]      |
| `DELETE /api/admin/dlq/:id`                    | Administrator bearer                                 | Deletion message                                                         | Missing `404`                                                                                                           | [Admin][admin]      |
| `POST /api/admin/achievements/reset-one-time`  | Administrator bearer; optional nonblank user         | Deletes null-threshold cumulative unlocks only                           | Blank user `400`; requested user with no matching rows `404`                                                            | [Admin][admin]      |
| `GET /api/admin/achievements/debug/counts`     | Administrator bearer                                 | Definition/progress/unlock/streak/history counts                         | Read failure `500`                                                                                                      | [Admin][admin]      |
| `GET /api/admin/achievements/debug/user/:user` | Administrator bearer                                 | Exact/case-insensitive diagnostics and recent events                     | Read failure `500`                                                                                                      | [Admin][admin]      |
| `GET /api/admin/commands`                      | Administrator bearer                                 | All definitions                                                          | Read failure `500`                                                                                                      | [Admin][admin]      |
| `POST /api/admin/commands`                     | Strict response-type-specific JSON                   | `201` definition                                                         | Invalid JSON/schema `400`; name/alias conflict `409`                                                                    | [Admin][admin]      |
| `PATCH /api/admin/commands/:name`              | Strict nonempty patch                                | Updated definition                                                       | Invalid/incomplete patch `400`; missing `404`; alias conflict `409`                                                     | [Admin][admin]      |
| `DELETE /api/admin/commands/:name`             | Canonical command name                               | Deletes source and dependent definitions                                 | Missing `404`; invalid name `400`                                                                                       | [Admin][admin]      |
| `GET /api/admin/commands/debug/snapshot`       | Administrator bearer                                 | Definitions, values, counters, totals, revision                          | Failure `500`                                                                                                           | [Admin][admin]      |
| `GET /api/admin/debug/stats/:user`             | Administrator bearer; trims leading `@`              | Component resolution/rendering matching `!stats`                         | Empty target `400`; independent component failures                                                                      | [Admin][admin]      |

### Shared HTTP invariants

- Administrator/debug/EventSub-management authentication fails closed with constant-time comparison. OAuth setup uses only its header; query secrets never authenticate.
- Logs/traces contain safe correlation and query keys, not credentials, OAuth codes, signed bodies, authorization headers or query values. [Telemetry tests](../apps/api/src/features/http/http-request-correlation.test.ts) exercise this boundary.
- Statistics use canonical cache keys and `Cache-Control: public, max-age=60`. Malformed cache data is ignored, best-effort evicted, and replaced only from parsed upstream data.
- Overlay polling is every five seconds, times out after four, suppresses concurrent polls, and validates Now Playing/queue payloads before DOM rendering.

## EventSub acceptance and dispatch

Signed HTTP ordering is part of the contract:

1. Parse required headers, numeric retry count and lowercase `sha256=` signature.
2. Reject timestamps outside ±10 minutes.
3. Bound declared and streamed body size to 1,048,576 bytes; decode UTF-8 fatally.
4. Verify HMAC-SHA256 over `messageId + timestamp + exactRawBody`.
5. Parse JSON and the message schema; require signed subscription type/version to match the body.
6. Return an authenticated challenge, or durably accept a notification by message ID.

Malformed headers/payload produce `400`, stale timestamp/bad signature `403`, oversized body `413`, and durable acceptance failure/conflict `503`.

The persisted receipt and recovery alarm precede acknowledgment; provider dispatch is asynchronous. Identical redelivery resumes work; conflicting reuse rejects. Dispatch maps online/offline to Stream Lifecycle, configured rewards to deterministic workflows, raid to shoutout workflow, and chat to commands. Revocation/unknown notifications are recorded without domain mutation.

Processing is pending/completed/dead-letter, with exponential retry capped at ten minutes and a 20-attempt budget. Sending chat becomes uncertain after interruption or ambiguous response and is not repeated; definite pre-delivery refusal may retry. Exact digest/lease/checkpoint representation belongs in the [inbox notes](../apps/api/src/features/workflows/WORKFLOW-MIGRATION.md#eventsub-inbox).

## Song Request workflow

Workflow identity is the redemption ID. Required order:

1. Parse Spotify track URI or `open.spotify.com` track URL; accept locale paths, ignore query/fragment.
2. Read track metadata and persist the Pending Request.
3. Add the canonical URI to Spotify Queue.
4. Fulfill the redemption and record the point of no return.
5. Send best-effort confirmation; publish stable `song_request_success` evidence.

Pre-fulfillment permanent failure compensates in reverse order: remove the exact queue occurrence, delete the pending attribution, then confirm cancellation/refund. Invalid input and provider unavailability retain their different user messages. Remote persistence commit with a lost response requires cleanup by stable identity before refund, or explicit uncertainty.

Spotify queue mutation is non-idempotent: ambiguous completion becomes `OUTCOME_UNKNOWN`, not another add. After fulfillment, required publication exhaustion becomes `POST_COMMIT_FAILED`; it cannot trigger compensation. Failure evidence must survive a crash before compensation begins so replay preserves the original reason and message.

## Song Queue read model

- Occurrences, not Track IDs, own attribution. Multiple appearances keep distinct identities; a new request cannot claim an already-playing occurrence.
- Position zero is Now Playing; public queue exposes positions above zero. Requested occurrences are FIFO by request time before Spotify autoplay order.
- An attributed current occurrence leaving playback creates Request History. A seen upcoming occurrence disappearing creates no history. Never-seen requests survive temporary absence until their one-hour TTL, with cleanup every five minutes.
- Reads refresh after 15 seconds, coalesce concurrent observation, and preserve the complete last snapshot on failure. Backoff grows to five minutes. Successful empty/offline observations keep polling.
- Snapshot replacement, attribution, pending transitions, and history insertion are transactional. Statistics group stable Track/Viewer IDs with latest metadata and deterministic identity tie-breaking.
- Lower-level queries retain inclusive instant-based date bounds, history pagination/session/viewer counts, and 30-minute pending/history duplicate detection. History limits are 1–100 and offsets 0–10,000.

Polling cannot prove playback that was never observed or perfectly distinguish arbitrary manual same-track reorder/removal. Supported stored formats and receipt retention rationale are in the [migration notes](../apps/api/src/features/song-queue/song-queue-migration.md).

## Keyboard Raffle

- A redemption creates one durable roll. Two unbiased cryptographic draws range from 1–10,000 inclusive; Distance is their absolute difference and only zero wins.
- Caller-supplied derived evidence is rejected. SQL and read-time refinement preserve ranges, distance, and winner equivalence.
- Equal immutable replay returns the original receipt; conflicting evidence rejects. A new closest record must be strictly smaller than all previous global non-winning distances; winners and ties do not qualify.
- Before fulfillment, confirmed deletion precedes refund. Commit-plus-response-loss cannot leave a roll active while refund succeeds. Compensation receipts/tombstones prevent resurrection.
- After fulfillment, event publication is required; chat and analytics are best effort. Chat includes Winning Number, Roll, and Distance. Rankings support rolls/wins/closest; the winners list excludes zero-win entries.

**Replacement decision:** the baseline persisted two random-number workflow checkpoints. New workflows use one atomic `getOrCreateRoll` receipt under `record-roll`. The durable draw is preserved without retaining the old internal step topology. Active legacy work needs the identity/checkpoint disposition described in [workflow migration](../apps/api/src/features/workflows/WORKFLOW-MIGRATION.md#state-ownership).

## Achievements

These seeded IDs and meanings are historical compatibility data:

| ID              | Name           | Trigger / threshold           | Scope               |
| --------------- | -------------- | ----------------------------- | ------------------- |
| `first_request` | First Timer    | Song Request / 1              | cumulative          |
| `request_10`    | Regular        | Song Request / 10             | cumulative          |
| `request_50`    | DJ in Training | Song Request / 50             | cumulative          |
| `request_100`   | Certified DJ   | Song Request / 100            | cumulative          |
| `stream_opener` | Stream Opener  | first Song Request in session | session             |
| `first_roll`    | Feeling Lucky  | Roll / 1                      | cumulative          |
| `roll_25`       | Persistent     | Roll / 25                     | cumulative          |
| `roll_100`      | Never Give Up  | Roll / 100                    | cumulative          |
| `first_win`     | Winner Winner  | win / 1                       | cumulative          |
| `close_call`    | So Close       | non-win Distance ≤100         | cumulative one-time |
| `closest_ever`  | Heartbreaker   | new global non-winning record | cumulative one-time |
| `streak_3`      | On a Roll      | request streak / 3            | session             |
| `streak_5`      | Hot Streak     | request streak / 5            | session             |

Progress identity is stable Viewer ID plus Achievement ID; display-name changes do not split it. Event ID deduplication, progress/unlock changes, and stable `eventId:achievementId` delivery intent commit atomically. Request streak progress is set from current streak count, not incremented independently. Online transition resets session progress/streaks, not cumulative unlocks; stale/repeated transitions cannot move the watermark backward.

**Behavioral correction:** Stream Opener requires the successful request itself to be strictly after accepted session start, rather than only filtering prior requests as the baseline did. Timestamp comparisons use instants across timezone offsets.

Metrics and chat have separate durable states. Interrupted sending becomes uncertain; definite retryable preflight/refusal uses the persisted 3/5/10-second budget with provider Retry-After precedence. Exhausted/non-retryable announcements are abandoned; session/admin reset abandons stale unsent effects. One-time reset affects null-threshold cumulative definitions only. Preserve `legacy-display:<normalized-name>` identities until explicitly reconciled. Historical SQL and outbox recovery details belong in [rewards verification](../apps/api/src/features/achievements/rewards-verification.md).

## Chat Commands

The historical catalog has 37 canonical names:

`keyboard`, `socials`, `github`, `twitter`, `schedule`, `font`, `dotfiles`, `today`, `project`, `plan`, `herdr`, `hex`, `achievements`, `stats`, `raffle-leaderboard`, `commands`, `update`, `song`, `queue`, `functor`, `location`, `ocaml`, `lurk`, `youtube`, `unlurk`, `errors`, `vibes`, `neovim`, `dict`, `beam`, `linux`, `time`, `leak`, `skillissue`, `truth`, `job`, `browser`.

Preserve baseline text, metadata, permissions, response types, handlers, enabled state and migration behavior. `df` aliases `dotfiles`; `project` shares `today`'s value. Applied migrations for `plan`, `herdr`, `hex`, and `df` remain non-destructive.

Permission order is broadcaster > moderator > VIP > everyone; subscription badges add no privilege. Non-command, unknown, disabled and permission-denied invocations send nothing. Dynamic writes recheck durable permission transactionally (`today`: moderator; `leak`: VIP). Same EventSub operation fingerprint replays the original result; conflicting input rejects. The historical dedupe guarantee is bounded to the latest 5,000 receipts.

Aliases are unique and sources exist; deleting a source recursively deletes dependents and prunes state. Preserve `${user}`/random-emote templates and the 500-code-point rendered limit. Computed commands include achievements, viewer stats, raffle winners, permission-filtered catalog, Now Playing, four-item queue, Eastern time, updates and idempotent `skillissue`. `song` reports playback even with an argument, despite its old description.

Registry/delivery representation, Unicode storage bounds, and rollback limitations belong in [commands migration](../apps/api/src/features/commands/commands-migration.md).

## Stream Lifecycle

Live state requires session identity and authoritative start time. Transition and intent persist together, with four resumable checkpoints: Spotify token notification, Twitch token notification, domain-event publication, and viewer polling. Pending earlier effects prevent a new transition; duplicates/stale evidence are no-ops.

Online source `started_at` is authoritative; signed EventSub time orders offline fallback. Live polling is every 60 seconds, preserving unique monotonic snapshot timestamps and peak viewer count. Reconciliation resumes same-state pending effects without replacing authoritative start time. Legacy representations and schedule evidence are documented in the [storage inventory](production-cutover.md#stream-and-event-bus-legacy-authority).

Local [transition tests](../apps/api/src/features/stream/stream-state.test.ts) cover instant ordering across offsets and precision representations while retaining source timestamp strings and strict-online/inclusive-offline equality. This does not establish native restart between checkpoints.

**Open history-query gap:** viewer history still uses lexical SQL timestamp bounds/order. A `julianday` replacement was rejected because SQLite excludes valid domain offsets beyond fourteen hours and differs in fractional precision. See the [implementation disposition](effect-api-implementation.md#rejected-sql-history-pilot); the lifecycle comparison correction does not close this separate query requirement.

## Event Bus

Route `song_request_success`, `raffle_roll`, `stream_online`, and `stream_offline` to Achievements. Stable delivered receipts suppress producer retries and reconcile stale pending/DLQ copies. Receipt insertion and pending/DLQ cleanup are transactional.

Initial failure queues durably; retries use 1/4/16 seconds, then atomically dead-letter. Retention is 30 days. Manual replay either succeeds or honestly retains the dead letter; deleting missing work returns not found. Restart reconstructs due work from SQL. Corrupt pending data moves with its original raw evidence and a safe reason, while valid due work continues. Retry and expiry each use their own minimum deadline.

## Providers and OAuth

Persist credentials, expiry, token type, stream/auth state, and retry/scheduling evidence. Initial setup needs refresh credentials; subsequent refresh may omit rotation and retain the existing token. Cached tokens are usable offline only outside the refresh buffer; expired/inside-buffer offline credentials do not cause provider I/O. Live refresh coalesces, rechecks under serialization, and schedules five minutes before expiry. Network retries use 1/2/4 minutes; other transient failures use ten minutes. Revocation/missing refresh credentials persist reauthorization-required and cancel scheduling.

OAuth state is a random UUID, provider/redirect-bound, one-use, and expires after ten minutes. Consumption precedes provider-denial/code handling; successful exchange is durably accepted before completion. Secrets stay Redacted through final I/O.

Mutation ambiguity is distinct from confirmed refusal. Spotify compensation refuses when multiple matching URIs prevent occurrence identification. Queue observation failure retains prior state; current-playing failure alone may fall back to the successful queue's current track. [Provider notes](../apps/api/src/features/providers/provider-migration-notes.md) own error/refresh and historical storage details.

## Workflow and raid recovery

Retain physical workflow identities from [durable authorities](architecture.md#durable-authorities). Stored statuses include RUNNING, COMPLETED, FAILED, COMPENSATING, COMPENSATION_FAILED, OUTCOME_UNKNOWN, and POST_COMMIT_FAILED. Cached success/undo values replay without re-executing handlers; corruption blocks replay.

Failure evidence, retry deadlines, compensation completion, and fulfillment's point of no return must survive interruption. Known-key undo intent precedes remote persistence; compensation runs in reverse and never claims refund while cleanup is unconfirmed. Raid sends thanks then shoutout, resumes confirmed checkpoints, and holds ambiguous provider outcomes rather than resending.

Historical runs are not automatically eligible for the new journal. Preserve physical-DO-ID mappings and prior event/draw/checkpoint identities through the [workflow format gate](../apps/api/src/features/workflows/WORKFLOW-MIGRATION.md). Production work disposition belongs exclusively to the [cutover procedure](production-cutover.md#approval-gates).

## Outstanding native acceptance

These journeys are required evidence, not a claim that the local harness already implements each fault. Harness operation and extension constraints belong in [verification](verification.md#local-workerd-harness). For each journey, record the exact test and outcome; a related SQL test cannot close a required native restart check.

1. **OAuth/token lifecycle:** cover setup rejection, one-use binding, malformed provider success and rotation retention; force concurrent expired readers and prove one exchange/recheck, then native restart with rotated credentials intact.
2. **Webhook security:** exercise challenge, missing/malformed retry headers, stale/future timestamps, bad HMAC, invalid UTF-8, declared/streamed size overflow, and subscription contradictions through workerd.
3. **Song Request playback:** signed redemption through one queue mutation and fulfillment, then observed playback/history and achievement unlock.
4. **Queue uncertainty:** disconnect after add acceptance; assert no second add, false refund, or loss of OUTCOME_UNKNOWN evidence.
5. **Song Request compensation:** definitive failure and commit-plus-response-loss; cleanup precedes confirmed cancellation. Interrupt between invalid-link failure persistence and compensation, preserving the original cause/message.
6. **Raffle:** controlled cryptographic source, exact receipt replay/conflict, strict global record, compensation and commit-loss; refund never coexists with an active committed roll.
7. **Commands:** permission/alias/value behavior, update/counter redelivery, output bound, and interruption after sending intent; recovery remains uncertain without resend.
8. **Raid:** thanks/shoutout checkpoint replay and ambiguous mutation recovery without duplicate sends.
9. **Stream:** source ordering, duplicate/stale transitions, native restart between each of four checkpoints, polling/peak count, offline cancellation and reconciliation.
10. **Event Bus/Achievements:** outage through retry/DLQ/replay/restart; dedupe, Stream Opener/streak/session reset. Native achievement alarm paths must prove chat/metric success, rate-limit retry, unknown non-retry, and sending-to-uncertain recovery after termination.
11. **Queue read model:** repeated tracks, already-playing exclusion, seen-disappeared removal, never-seen TTL, played-only history, stale fallback and transactional failure.
12. **Persistence:** stop/restart workerd between acceptance and significant durable checkpoints; inspect only through HTTP contracts.
13. **Stage isolation:** assert isolated resource identities and absence of production adoption/transfer actions in the local plan.

Representative [native tests][native] already demonstrate both OAuth flows, OAuth one-use/expiry alarm, token concurrency, signed command/song/raffle/stream/raid intake, EventSub alarm dispatch, one pending request on duplicate delivery, and `first_request` achievement unlock. The [Song Queue scenario](../apps/api/src/features/song-queue/scenario/song-queue-scenario.workerd.ts) demonstrates its Worker-to-DO HTTP/SQL graph. Arbitrary process eviction, the full fault/security/playback matrix, and native achievement announcement recovery remain unverified. Actual production inventory and reconciliation remain separate blockers.

[http]: ../apps/api/src/features/http/twitch-http.test.ts
[admin]: ../apps/api/src/features/http/twitch-admin.test.ts
[oauth]: ../apps/api/src/features/http/twitch-oauth.test.ts
[webhook]: ../apps/api/src/features/http/eventsub-webhook.test.ts
[native]: ../apps/api/test/e2e.test.ts
