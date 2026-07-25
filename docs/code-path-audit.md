# Application code-path audit

## Scope and method

This is a static audit of the production TypeScript reachable from `apps/api/src/index.ts` and the Durable Object exports in that file. It covers:

- all 39 HTTP routes;
- all Twitch EventSub notification branches;
- all public Durable Object RPC paths;
- all saga steps, retries, compensation paths, and terminal states;
- all Agent queue/schedule callbacks;
- Spotify and Twitch outbound calls;
- cache, persistence, analytics, logging, and error paths.

Tests, fixtures, generated migrations, schema declarations, and unreachable helpers are not expanded line by line. They are considered where they affect production persistence or verification. This is a static call-path outline, not a production trace: dynamic framework internals in Hono, Cloudflare Workers, Durable Objects, and the `agents` package are represented at their interfaces.

Verification at audit time:

- `pnpm --filter cf-twitch-api typecheck`: passed.
- `pnpm --filter cf-twitch-api test -- --run`: 29 files passed; 236 tests passed and 6 skipped.

## 1. Runtime topology

```text
Internet / Twitch / OBS
  -> Cloudflare Worker (`src/index.ts`)
     -> Hono route
        -> local library/module
        -> Durable Object RPC seam
           -> singleton state or per-event saga state
        -> Spotify/Twitch HTTP interface
        -> Analytics Engine / Cache API / structured logs

Agent schedules
  -> Durable Object callback
     -> persistence and/or external HTTP
     -> schedule next callback or stop
```

### Singleton Durable Objects

`getStub()` maps these bindings to stable names:

- `SPOTIFY_TOKEN_DO` -> `spotify-token`
- `TWITCH_TOKEN_DO` -> `twitch-token`
- `STREAM_LIFECYCLE_DO` -> `stream-lifecycle`
- `SONG_QUEUE_DO` -> `song-queue`
- `ACHIEVEMENTS_DO` -> `achievements`
- `KEYBOARD_RAFFLE_DO` -> `keyboard-raffle`
- `EVENT_BUS_DO` -> `event-bus`
- `COMMANDS_DO` -> `commands`

Per-event Durable Objects require an explicit ID:

- `SONG_REQUEST_SAGA_DO` -> redemption ID
- `KEYBOARD_RAFFLE_SAGA_DO` -> redemption ID
- `RAID_SHOUTOUT_SAGA_DO` -> EventSub message ID

### Common Durable Object RPC stack

```text
caller
  -> getStub(binding, optional ID)
  -> namespace.idFromName()
  -> namespace.get()
  -> wrapStub proxy
     -> initialize Agent name through PartyServer fetch or setName RPC
     -> invoke Durable Object RPC
  -> @rpc serializes better-result Result to a cloneable object
  -> proxy Result.deserialize()
  -> caller receives Result<T, domain error | DurableObjectError>
```

`SongQueueDO` has an additional RPC-target seam:

```text
caller -> getSongQueue() -> SONG_QUEUE_DO.get(id) -> connectRpc()
  -> RpcTarget SongQueueClient -> callRpcResult() -> local SongQueueClient
```

### Common HTTP stack

Every request passes through `src/index.ts` middleware:

```text
Worker.fetch
  -> derive requestId and traceId
  -> attach request-scoped Logger to Hono context
  -> log request metadata
  -> withLogContext(next)
  -> mounted route
  -> set response request/trace headers
  -> log completion
```

Thrown errors are logged and rethrown to Hono/Worker handling. Most expected failures are represented as `Result` and converted to explicit HTTP responses in routes.

## 2. HTTP route inventory and call stacks

### Health and overlay

#### `GET /health`

```text
index middleware -> health handler -> JSON { status: "ok" }
```

No dependencies or persistence.

#### `GET /overlay/now-playing`

```text
index middleware -> overlay route -> render static HTML/CSS/JS
browser startup -> parallel GET /api/now-playing + GET /api/queue?limit=1
browser every 5 seconds -> toggle current/next view; refetch as needed
```

Browser branches: missing DOM node -> stop update; no current track -> empty state; current track but no next track -> retain/refetch current; requester absent/`Unknown` -> omit attribution; album image absent -> hide image.

### Public Spotify Queue data

#### `GET /api/now-playing`

```text
route -> getSongQueue() -> SongQueueDO.connectRpc()
  -> SongQueueDO.getCurrentlyPlaying()
     -> ensureFresh()
        -> fresh snapshot: no-op
        -> concurrent sync: await sync lock
        -> stale: runSyncCycle() -> syncFromSpotify()
     -> read snapshot position 0
  -> 200 track/null or 500
```

A Spotify sync failure deliberately falls back to stale SQLite snapshot data.

#### `GET /api/queue?limit=10`

```text
route -> validate limit (1..100)
  -> getSongQueue() -> SongQueueDO.getSongQueue(limit)
     -> ensureFresh() [same sync path]
     -> read positions > 0
     -> user-attributed tracks sorted FIFO, then Spotify autoplay order
  -> 200, 400 validation error, or 500
```

#### `GET /api/song-requests/history?limit=10`

```text
route -> Number(limit)
  -> getSongQueue() -> SongQueueDO.getRequestHistory(limit)
  -> request_history query + count query
  -> 200 or 500
```

Unlike `/api/queue`, this route has no finite/range validation.

### Public achievements

#### `GET /api/achievements/definitions`

```text
route -> AchievementsDO.getDefinitions() -> SQLite definitions -> 200/500
```

#### `GET /api/achievements/leaderboard?limit=10`

```text
route -> Number(limit) -> AchievementsDO.getLeaderboard()
  -> group unlocked rows by exact display name -> 200/500
```

#### `GET /api/achievements/:user`

```text
route -> AchievementsDO.getUserAchievements(exact display name)
  -> definitions + viewer progress -> merged projection -> 200/500
```

#### `GET /api/achievements/:user/unlocked`

```text
route -> AchievementsDO.getUnlockedAchievements(exact display name)
  -> joined unlocked rows ordered newest first -> 200/500
```

### Public cached stats

All five routes use:

```text
route validation
  -> withEdgeCache(context, fetcher, onError, 60 seconds)
     -> Cache API hit: return cached response
     -> miss/lookup failure: invoke Durable Object
        -> domain/infrastructure error: uncached 4xx/5xx
        -> success: JSON 200 + Cache-Control; waitUntil(cache.put)
```

Routes:

- `GET /api/stats/top-tracks?limit=` -> `SongQueueDO.getTopTracks()`.
- `GET /api/stats/top-tracks/:user?limit=` -> `SongQueueDO.getTopTracksByUser()`.
- `GET /api/stats/top-requesters?limit=` -> `SongQueueDO.getTopRequesters()`.
- `GET /api/stats/raffle/leaderboard?sortBy=&limit=` -> `KeyboardRaffleDO.getLeaderboard()`.
- `GET /api/stats/raffle/user/:user` -> `KeyboardRaffleDO.getUserStats()`; missing viewer -> 404; DO infrastructure -> 503; other errors -> 500.

### Debug routes

All `/api/debug/*` routes first pass bearer authentication:

```text
ADMIN_SECRET absent -> 503
Authorization absent -> 401
wrong format -> 401
constant-time token mismatch -> 403
match -> route
```

#### `GET /api/debug/stream-state`

`StreamLifecycleDO.getStreamState()` -> 200/500.

#### `GET /api/debug/keyboard-raffle/leaderboard`

Unvalidated cast/number conversion -> `KeyboardRaffleDO.getLeaderboard()` -> 200/500.

#### `POST /api/debug/reconcile-stream-state`

```text
parallel:
  StreamLifecycleDO.getStreamState()
  TwitchService.getStreamInfo(name)
    -> Twitch client-credentials token
    -> Helix /streams
state error -> 500
twitch error -> 500
Twitch live + local offline -> StreamLifecycleDO.onStreamOnline()
Twitch offline + local live -> StreamLifecycleDO.onStreamOffline()
otherwise -> no-op
if set online -> SongQueueDO.getCurrentlyPlaying() warmup (best effort)
StreamLifecycleDO.getStreamState() final read
-> reconciliation JSON or 500
```

#### `GET /api/debug/status`

Parallel local stream state, queue snapshot, and Twitch stream lookup. Returns 200 even with partial failures; each subsystem embeds `ok` and error state.

### Admin routes

All `/api/admin/*` routes pass bearer auth equivalent to debug auth. The route handlers use the global logger rather than the request logger.

#### Event bus administration

- `GET /api/admin/dlq` -> validate pagination -> `EventBusDO.getDLQ()`.
- `GET /api/admin/event-bus/pending` -> validate pagination -> `EventBusDO.getPending()`.
- `POST /api/admin/dlq/:id/replay` -> `EventBusDO.replayDLQ()` -> 404 missing, 500 infrastructure/validation, or 200 with delivery success/failure.
- `DELETE /api/admin/dlq/:id` -> `EventBusDO.deleteDLQ()` -> 404/500/200.

#### Achievement administration

- `POST /api/admin/achievements/reset-one-time?user=` -> delete cumulative event-based unlock rows; specific viewer with no rows -> 404.
- `GET /api/admin/achievements/debug/counts` -> counts five tables/projections.
- `GET /api/admin/achievements/debug/user/:user` -> exact, case-insensitive, loose-name, event, and streak diagnostics.

#### Chat Command administration

- `GET /api/admin/commands` -> `CommandsDO.getAllCommands()`.
- `POST /api/admin/commands` -> JSON parse -> Zod parse -> `CommandsDO.createCommand()` -> 201/400/500.
- `PATCH /api/admin/commands/:name` -> JSON/Zod parse -> `CommandsDO.updateCommand()` -> 200/400/404/500.
- `DELETE /api/admin/commands/:name` -> `CommandsDO.deleteCommand()` -> 200/404/500.
- `GET /api/admin/commands/debug/snapshot` -> definitions, values, counters, totals, revision.
- `GET /api/admin/debug/stats/:user` -> parallel achievements, definitions, song count, raffle stats -> diagnostic JSON and rendered chat response.

### OAuth

Authorize endpoints require `OAUTH_SETUP_SECRET` through `X-Setup-Secret` or a query parameter. Callback endpoints do not pass this middleware.

#### `GET /oauth/spotify/authorize`

```text
setup-secret middleware -> construct callback from request origin
  -> construct Spotify authorize URL/scopes -> 302
```

#### `GET /oauth/spotify/callback`

```text
provider error -> 400
missing code -> 400
code -> SpotifyService.exchangeToken()
  -> POST accounts.spotify.com/api/token
  -> network/non-2xx/parse failure -> 500
  -> SpotifyTokenDO.setTokens()
  -> report success
```

#### `GET /oauth/twitch/authorize`

Same pattern; constructs Twitch authorize URL and user-token scopes.

#### `GET /oauth/twitch/callback`

Same pattern; exchanges at Twitch OAuth, then `TwitchTokenDO.setTokens()`.

### EventSub management

These routes currently have no route-specific authentication.

- `POST /eventsub/setup`: get app token, list existing subscriptions, compare type/version/status/callback/conditions, sequentially create each missing online/offline/redemption/chat/raid subscription, then 200 or aggregate 500.
- `GET /eventsub/list`: get app token -> list subscriptions -> 200/500.
- `DELETE /eventsub/:id`: get app token -> delete one -> 200/500.
- `POST /eventsub/cleanup`: list, sequentially delete every subscription, return aggregate counts (always HTTP 200 after a successful list).

## 3. Twitch webhook dispatch tree

### Shared verification

```text
POST /webhooks/twitch
  -> require EventSub headers
  -> read raw body
  -> reject timestamp older/newer than 10 minutes
  -> HMAC-SHA256(secret, messageId + timestamp + body)
  -> compare signature
  -> JSON parse
```

Terminal branches before notification dispatch:

- invalid headers/body/payload/unknown message type -> 400;
- stale timestamp or bad signature -> 403;
- callback verification -> return challenge text 200;
- revocation -> log and return 200.

Notifications parse a common envelope, dispatch by subscription type, catch thrown processing errors, and return 200 after dispatch even when downstream processing failed.

### `stream.online`

```text
webhook -> StreamLifecycleDO.onStreamOnline(header timestamp)
  -> resolve transition timestamp
  -> stale transition: ignore
  -> already live: ignore
  -> create Stream Session ID; persist LiveStream state
  -> parallel side effects:
     notifyTokenDOsOnline()
       -> SpotifyTokenDO.onStreamOnline()
       -> TwitchTokenDO.onStreamOnline()
       -> EventBusDO.publish(stream_online)
          -> AchievementsDO.handleEvent()
     ensure 60-second viewer polling schedule
```

Achievement event path resets session-scoped Achievement Progress and all Request Streaks, then sets achievement stream-session state live.

### `stream.offline`

```text
webhook -> StreamLifecycleDO.onStreamOffline(header timestamp)
  -> stale transition: ignore
  -> already offline: ignore
  -> persist OfflineStream state
  -> parallel:
     SpotifyTokenDO.onStreamOffline() -> cancel refresh schedule
     TwitchTokenDO.onStreamOffline() -> cancel refresh schedule
     EventBusDO.publish(stream_offline) -> AchievementsDO state offline
     cancel viewer polling schedule
```

### Channel Point Redemption routing

```text
parse redemption
  -> validate reward routing config
  -> unknown reward: log/ignore
  -> Song Request reward: SongRequestSagaDO(redemption ID).start()
  -> Keyboard Raffle reward: KeyboardRaffleSagaDO(redemption ID).start()
```

### Raid

```text
parse raid -> RaidShoutoutSagaDO(EventSub message ID).start()
```

### Chat message

```text
parse message/badges
  -> derive broadcaster > moderator > VIP > everyone permission
  -> lowercase entire message text
  -> makeChatCommandExecutor(env)
  -> ChatCommandEngine.execute()
```

Chat Command engine branches:

```text
parse !command and optional argument
  not command -> ignored
  CommandsDO.getCommand(name/alias)
    missing -> ignored unknown
    DB/infrastructure error -> error
  disabled -> ignored
  insufficient permission -> ignored
  response type:
    static/dynamic -> CommandsDO.getCommandValue()
      absent -> emptyResponse
      present -> render stored viewer/value and output templates
    computed -> handler registry
      missing handler -> configuration warning text
      handler -> handler-specific flow
  text response -> TwitchService.sendChatMessage()
  no-response -> skip send
  write analytics and logs -> completed/error
```

Computed handlers:

- `song`: `SongQueueDO.getCurrentlyPlaying()`; error/no-track/track branches.
- `queue`: `SongQueueDO.getSongQueue(4)`; error/empty/list branches.
- `achievements`: `AchievementsDO.getUnlockedAchievements(target)`; error/empty/list branches.
- `stats`: achievements + definitions, then song history + raffle stats; self uses Viewer ID, target uses exact display name.
- `raffle-leaderboard`: leaderboard by wins; error/empty/no-winner/winners branches.
- `commands`: commands visible at permission level, grouped by tier.
- `update`: usage validation -> command lookup -> updateability -> write permission -> `CommandsDO.setCommandValue()`.
- `skillissue`: `CommandsDO.incrementCommandCounter("skillissue")`.
- `time`: format current time in `America/New_York`.

## 4. Saga lifecycle shared by all three sagas

```text
SagaHost.start(input)
  -> codec parse
  -> SagaRunner.initSaga()
     new: insert RUNNING saga row
     existing: idempotently resume existing row
  -> resume only if status RUNNING
  -> decode persisted params
  -> concrete runSaga()
```

Each step:

```text
existing SUCCEEDED row
  -> decode persisted result (+ undo evidence for rollback step)
  -> replay without rerunning handler
otherwise
  -> upsert PENDING with incremented attempt
  -> race handler against timeout
  success -> encode result/undo -> mark SUCCEEDED
  retryable failure with attempts remaining
    -> persist PENDING + nextRetryAt
    -> SagaHost schedules retrySagaTick
    -> return SagaStepRetrying
  terminal failure -> mark step FAILED -> SagaStepError
```

On cold start, `SagaHost.onStart()` migrates SQLite and reconstructs a missing retry schedule from persisted `nextRetryAt`. A scheduled callback ignores stale schedule payloads and resumes only a RUNNING saga.

### Song Request saga

Happy path:

```text
1 parse-spotify-url
   -> parse URL/URI/track ID
2 get-track-info
   -> SpotifyTokenDO.getValidToken()
   -> Spotify GET /v1/tracks/:id
3 persist-request [rollbackable]
   -> SongQueueDO.persistRequest(Pending Request)
   rollback -> SongQueueDO.deleteRequest()
4 add-to-spotify-queue [rollbackable]
   -> Spotify GET queue
   -> matching track already present: skip add
   -> otherwise Spotify POST queue
   rollback -> if track is Now Playing, skip it; otherwise leave it queued
5 fulfill-redemption
   -> TwitchTokenDO.getValidToken()
   -> Twitch PATCH redemption FULFILLED
6 mark point of no return
7 send-chat-confirmation [best effort]
8 publish song_request_success [best effort]
   -> EventBusDO -> AchievementsDO
9 mark saga COMPLETED
```

Pre-fulfillment terminal failure:

```text
reverse registered compensations
  -> attempt Spotify rollback
  -> delete Pending Request
Twitch PATCH redemption CANCELED
send viewer failure message
mark saga FAILED
```

A retrying step remains RUNNING and is resumed by schedule. A failure after the point of no return does not compensate/refund.

### Keyboard Raffle saga

Happy path:

```text
1 generate-winning-number (1..10,000; persisted for replay)
2 generate-user-roll (1..10,000; persisted for replay)
3 calculate Distance and winner
4 record-roll [rollbackable]
   -> KeyboardRaffleDO.recordRoll()
   -> determine global closest non-winning record
   rollback -> delete roll
5 Twitch redemption FULFILLED
6 mark point of no return
7 publish raffle_roll [best effort]
   -> EventBusDO -> AchievementsDO
8 send win/loss chat message [best effort]
9 mark COMPLETED and write raffle analytics
```

Pre-fulfillment terminal failure compensates the Roll and cancels the redemption. Retry scheduling failures are returned without marking the saga failed.

### Raid shoutout saga

```text
1 send chat thanks with channel URL
2 create native Twitch shoutout
3 mark COMPLETED
```

Both steps use saga retry policy. Unlike the redemption sagas, this saga has no concrete terminal-failure handler, compensation, or explicit `runner.fail()` path.

## 5. Event bus and Achievement processing

### Event bus

All four domain event types route to `AchievementsDO`:

- `song_request_success`
- `raffle_roll`
- `stream_online`
- `stream_offline`

```text
EventBusDO.publish(event)
  -> Zod validation failure: error
  -> AchievementsDO.handleEvent()
     success -> done
     failure/throw -> persist pending retry with same event ID
```

Retry schedule:

- initial retry delay: 1 second;
- subsequent delays: 4 seconds, then 16 seconds;
- after three retry attempts: transactionally move to DLQ;
- DLQ expires after 30 days;
- earliest pending retry and earliest DLQ expiry each own an Agent schedule.

Pending corruption is deleted. DLQ replay directly redelivers: success deletes the item; failure updates its error/time and leaves it in the DLQ.

### Achievement rule stack

```text
AchievementsDO.handleEvent()
  -> validate event
  -> insert event_history ON CONFLICT DO NOTHING
  -> load definitions + viewer progress/streak + Stream Session facts
  -> evaluateAchievementRules() [pure]
  -> sequentially apply decisions
  -> queue unlock analytics/chat effects
```

Rules:

- Song Request: increment `song_request`; optionally unlock `stream_first_request`; increment Request Streak; from streak 3 onward set `request_streak` progress.
- Keyboard Raffle: increment `raffle_roll`; if Distance 0 apply `raffle_win`; if non-win Distance <= 100 apply `raffle_close`; if non-win global closest record apply `raffle_closest_record`.
- stream online: mark live, reset session achievements, reset all Request Streaks.
- stream offline: mark offline.

Unlock effect path:

```text
Agent queue -> analytics (first attempt only)
  -> TwitchTokenDO.getValidToken() preflight
     retryable preflight failure -> schedule after 3s, 5s, then 10s
     terminal/exhausted -> skip announcement
  -> atomically mark announced
  -> TwitchService.sendChatMessage()
```

Once marked announced, a chat-send failure is not retried.

## 6. Persistent modules and background paths

### SongQueueDO

SQLite owns:

- Pending Requests;
- denormalized Spotify Queue snapshot;
- Request History.

Mutation/sync paths:

```text
persist Pending Request
  -> invalidate lastSyncAt
  -> schedule refresh in 1 second
  -> ensure 5-minute stale-pending cleanup

read Now Playing/queue
  -> if snapshot older than 15 seconds, coalesced Spotify sync
  -> on sync failure, serve stale snapshot

sync
  -> read prior position 0 + all Pending Requests
  -> parallel Spotify currently-playing and queue calls
  -> require queue success before snapshot mutation
  -> FIFO-match Pending Requests to Spotify Track IDs
  -> if prior user-attributed position 0 changed, move it to Request History
  -> replace snapshot
  -> mark matched Pending Requests seen
  -> delete previously seen requests no longer represented
  -> delete Pending Requests older than one hour
  -> continue refresh while pending/snapshot activity exists
```

Refresh failures back off from 15 seconds exponentially to 5 minutes. Cleanup runs every 5 minutes while pending work exists.

### KeyboardRaffleDO

- insert/delete Rolls;
- compute leaderboard through a SQLite view;
- exact Viewer ID and display-name lookup;
- global closest non-winning Roll lookup.

### CommandsDO

Agent state owns command definitions, values, counters, migration IDs, and revision. Startup bootstraps defaults once and applies additive default migrations. Every mutation constructs a whole next state, validates cross-references/aliases/response-type invariants, increments revision, then calls `setState()`.

Read/write paths include alias resolution, permission filtering, dynamic value updates, counter increments, create/update/delete, dependent-command cascade deletion, and debug projections.

### SpotifyTokenDO and TwitchTokenDO

Both follow the same state machine:

```text
OAuth setTokens
  -> persist token + expiry
  -> if live, schedule refresh 5 minutes before expiry

getValidToken
  -> valid token: return
  -> no token: StreamOfflineNoTokenError
  -> expired and offline: StreamOfflineNoTokenError
  -> expired and live: coalesced refresh

stream online
  -> set live
  -> expired token: refresh
  -> valid token: restore/schedule proactive refresh

stream offline
  -> set offline; reset retries; cancel schedule

refreshTokenTick
  -> success: persist token and next proactive schedule
  -> network failure: retry at 1m, 2m, 4m
  -> exhausted/non-network failure: retry after 10m
```

Spotify additionally maps OAuth `invalid_grant` to authorization revoked. Twitch currently maps all refresh non-2xx responses to network refresh errors.

### StreamLifecycleDO viewer polling

While live, a 60-second schedule calls:

```text
pollViewerCountTick
  -> TwitchService.getStreamInfo() with app token
  -> offline/error: no snapshot
  -> live: insert monotonic-timestamp viewer snapshot
  -> update peak viewer count when higher
```

Compatibility `onRequest()` paths also exist inside the Durable Object for `/stream-online`, `/stream-offline`, `/record-viewer-count`, `/state`, `/history`, and `/is-live`; no Worker route currently forwards to them.

## 7. Outbound interfaces

### Spotify

- OAuth code exchange and refresh.
- Track metadata.
- add to Spotify Queue.
- Now Playing.
- Spotify Queue.
- skip playback.
- active devices.
- undocumented client-token and connect-state calls for queue removal support.

`removeFromQueue()` and its undocumented interface are implemented but are not called by current production paths.

### Twitch

- OAuth code exchange and refresh.
- app client-credentials token (fetched anew per call).
- stream information.
- EventSub list/create/delete.
- chat message send.
- native shoutout.
- Channel Point Redemption status update.

Chat, shoutout, and redemption calls use `better-result` retries up to three times with exponential delay. Spotify methods mostly leave retry policy to saga steps.

## 8. Audit findings

### High priority

1. **EventSub management is unauthenticated.** `src/routes/eventsub-setup.ts` exposes setup, list, delete, and cleanup without an auth middleware. An external caller can inspect or disrupt subscriptions and force app-token traffic.

2. **OAuth authorize/callback has no `state` correlation.** `src/routes/oauth.ts` protects the authorize redirect with a shared setup secret but sends no OAuth `state` and accepts any callback code. This permits login-CSRF/token-substitution scenarios. The setup secret may also be placed in a query string.

3. **Achievement event replay is not idempotent for threshold achievements.** `AchievementsDO.recordToEventHistory()` ignores duplicate inserts, but `handleEvent()` continues to load facts and apply rules. Replaying the same Song Request or Keyboard Raffle event can increment threshold-based Achievement Progress and Request Streaks again. This conflicts with the method comment that retried events are “safely ignored.”

4. **Stream transition state is committed before required side effects, while duplicate delivery skips those effects.** `StreamLifecycleDO.onStreamOnline()`/`onStreamOffline()` calls `setState()` before token notifications, EventBus publication, and schedule changes. A crash between state persistence and side effects causes EventSub redelivery to hit the duplicate guard and return without repairing the missing work.

5. **The entire Chat Command text is lowercased before command parsing.** `src/routes/webhooks.ts` passes `message.text.trim().toLowerCase()`. This mutates dynamic values written by `!update` and lowercases target display names, while achievement/song/raffle display-name lookups are exact-case. `parseCommandWithArg()` already lowercases only the command token and should receive the original trimmed text.

6. **Song Request deduplication can fulfill the wrong queue intent.** The `add-to-spotify-queue` step treats any matching Spotify Track already in the Spotify Queue as proof this request was added. A matching autoplay track or another Viewer's request can cause the new redemption to be fulfilled without adding another queue occurrence; FIFO Track-ID attribution can then assign the existing occurrence to the new Pending Request.

### Medium priority

7. **OAuth callbacks report success even if token persistence fails.** Both callbacks await `stub.setTokens(tokens)` but discard the returned `Result`, so Durable Object infrastructure failure still produces a success response.

8. **Raid shoutout terminal failures do not transition the saga to `FAILED`.** Once a step exhausts retries, `_RaidShoutoutSagaDO.runSaga()` returns the error directly. `SagaHost` does not mark it failed, leaving a `RUNNING` saga with a failed step and no coordinated future retry.

9. **Webhook notifications acknowledge downstream failures with HTTP 200.** Invalid event-specific payloads, failed stream RPCs, failed saga starts, and caught exceptions all reach `{ success: true }`. This prevents Twitch redelivery. Some downstream modules have durable retries, but failures before durable acceptance can be lost.

10. **Stream ordering uses EventSub message time instead of event time.** Online notifications expose `event.started_at`, but the route sends the header delivery timestamp into `StreamLifecycleDO`. Delayed/out-of-order delivery can therefore make stale-event detection reflect delivery order rather than the Stream Session's authoritative transition time.

11. **Several numeric query paths are unvalidated.** Song Request history, achievement leaderboard, debug raffle leaderboard, and some admin paths use `Number(...)` directly. `NaN`, negative, or very large values can reach persistence queries or unvalidated options.

12. **Webhook HMAC comparison is not constant-time.** `verifySignature()` uses direct string equality even though the repository has `constantTimeEquals()` for secret comparison.

13. **Achievement announcement claims are lossy by design.** `markAnnounced()` runs before chat send; a send failure permanently suppresses retry. The code documents this choice, but it means persisted `announced=true` does not guarantee an announcement occurred.

14. **Song Request rollback cannot generally undo Spotify Queue insertion.** If the track is not currently playing, compensation leaves it queued. The implemented undocumented `removeFromQueue()` path is unused. The saga can cancel/refund while playback still contains the Spotify Track.

### Lower-priority observations

15. App access tokens are fetched through client credentials for every stream/EventSub operation rather than cached.

16. Public achievement and display-name stats reads are exact-case even though debug code already contains normalization helpers.

17. `/eventsub/cleanup` returns HTTP 200 when individual deletes fail, encoding failure only in the response body.

18. Debug/admin logging is inconsistent: debug routes use request-scoped logging, while admin routes mostly use the global logger and lose request/trace context.

19. `withRpcSerialization()` is a no-op retained for compatibility, despite many exports describing it as the production serialization wrapper. Actual serialization is owned by `@rpc`; the naming can mislead maintainers auditing RPC safety.

## 9. Suggested remediation order

1. Authenticate all EventSub management routes and remove setup secrets from query-string support.
2. Add OAuth `state`, persist/validate it, and check `setTokens()` results.
3. Make `AchievementsDO.handleEvent()` return immediately when `event_history` reports a duplicate.
4. Make stream-transition side effects durably replayable, or add reconciliation that runs even for duplicate state transitions.
5. Preserve original Chat Command arguments and lowercase only the command name.
6. Replace Track-ID-presence inference with occurrence-aware Song Request attribution/idempotency.
7. Give raid shoutout sagas an explicit terminal-failure transition.
8. Decide which webhook failures must return non-2xx before durable acceptance.
9. Use authoritative event timestamps and shared query schemas.
10. Apply constant-time webhook signature comparison and decide whether announcement/Spotify compensation loss is acceptable.
