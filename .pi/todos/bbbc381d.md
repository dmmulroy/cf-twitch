{
  "id": "bbbc381d",
  "title": "Migrate TwitchTokenDO from DurableObject to Agent",
  "tags": [
    "cloudflare-agents",
    "durable-objects",
    "refactor",
    "twitch-token",
    "oauth"
  ],
  "status": "closed",
  "created_at": "2026-04-05T21:30:04.557Z"
}

## Goal

Migrate `apps/api/src/durable-objects/twitch-token-do.ts` from `DurableObject<Env>` to `Agent<Env, TwitchTokenAgentState>` using the playbook in `docs/durable-object-agent-migration-guide.md`.

This TODO is intended as a complete handoff for someone with **no prior context**.

---

## Why `TwitchTokenDO` is the next migration target

After `StreamLifecycleDO`, `TwitchTokenDO` is the best next candidate because it exercises the most reusable Agent patterns **without** taking on the complexity/risk of `SongQueueDO`, `AchievementsDO`, `EventBusDO`, or the saga DOs.

### Why this is a stronger next step than `CommandsDO`

`CommandsDO` would be safe, but it would not meaningfully exercise the migration lessons from `docs/durable-object-agent-migration-guide.md`:

- no alarm/scheduling migration
- no current-state ownership problem
- no constructor bootstrap complexity beyond migrations
- no one-time state migration challenge

`TwitchTokenDO` **does** directly exercise the important lessons:

- constructor bootstrap should move into `onStart()`
- current mutable state should have one source of truth
- raw `alarm()`/`setAlarm()` logic should move to Agent scheduling
- one-time migration should replace dual-read / dual-write logic
- tests can stay on public behavior with `fetchMock` and `runInDurableObject(...)`

### Why `TwitchTokenDO` is still reasonably bounded

It has a small public contract and existing focused tests, but it still uses enough lifecycle features to make the migration worthwhile:

- singleton token state
- in-memory cache today
- proactive refresh scheduling
- retry/fallback behavior
- stream online/offline hooks from `StreamLifecycleDO`
- existing test coverage in `apps/api/src/__tests__/durable-objects/twitch-token-do.test.ts`

### Why not migrate both token DOs at once

`SpotifyTokenDO` is nearly the same shape, but do **not** try to generalize both in the same first change unless the shared abstraction is extremely obvious after the Twitch migration lands.

Best approach:
1. migrate `TwitchTokenDO` cleanly
2. use that diff as the template for `SpotifyTokenDO`

---

## Primary files to read before changing code

### Target implementation
- `apps/api/src/durable-objects/twitch-token-do.ts`
- `apps/api/src/durable-objects/schemas/token-schema.ts`
- `apps/api/drizzle/token-do/migrations`

### Migration guidance
- `docs/durable-object-agent-migration-guide.md`
- `AGENTS.md`
- `apps/api/src/durable-objects/AGENTS.md`

### Callers / consumers that define the public contract
- `apps/api/src/routes/oauth.ts`
- `apps/api/src/services/twitch-service.ts`
- `apps/api/src/durable-objects/stream-lifecycle-do.ts`

### Existing tests
- `apps/api/src/__tests__/durable-objects/twitch-token-do.test.ts`
- `apps/api/src/__tests__/fixtures/twitch.ts`

### Useful comparison
- `apps/api/src/durable-objects/stream-lifecycle-do.ts` (successful Agent migration pattern)
- `apps/api/src/durable-objects/spotify-token-do.ts` (near-clone follow-up candidate)

---

## Current `TwitchTokenDO` design summary

### File
- `apps/api/src/durable-objects/twitch-token-do.ts`

### Current class shape
- `class _TwitchTokenDO extends DurableObject<Env> implements StreamLifecycleHandler<TokenError>`

### Current public RPC methods
Inventory these first and preserve them unless there is a very strong reason not to:

1. `onStreamOnline(): Promise<Result<void, TokenError>>`
2. `onStreamOffline(): Promise<Result<void, TokenError>>`
3. `getValidToken(): Promise<Result<string, TokenError>>`
4. `setTokens(tokens: TwitchTokenResponse): Promise<Result<void, never>>`

### Current scheduled/lifecycle entrypoint
- `alarm(): Promise<void>`

### Current storage/state model

#### In-memory / process-local state today
- `tokenCache: TokenSet | null`
- `refreshPromise: Promise<Result<string, TokenError>> | null`

#### SQLite / Drizzle state today
`token_set` row stores:
- `accessToken`
- `refreshToken`
- `tokenType`
- `expiresIn`
- `expiresAt`
- `isStreamLive`

#### Additional raw DO storage key today
- `alarmRetryCount`

### Current runtime behavior

#### Startup / constructor
The constructor currently:
- initializes Drizzle
- runs migrations
- loads the singleton `token_set` row into memory
- proactively refreshes on startup if the stream is live and token is already expired / in refresh window
- reschedules an alarm if the stream is live

#### Online transition
`onStreamOnline()` currently:
- marks `isStreamLive = true` in SQLite
- mirrors that into the in-memory cache
- refreshes immediately if token is expired or inside the refresh buffer
- schedules an alarm for proactive refresh

#### Offline transition
`onStreamOffline()` currently:
- marks `isStreamLive = false`
- mirrors that into the cache
- cancels the DO alarm
- clears `alarmRetryCount`

#### Token reads
`getValidToken()` currently:
- returns cached token if still valid
- errors if no token
- errors if token expired and stream offline
- refreshes if token expired and stream live
- coalesces concurrent refreshes with `refreshPromise`

#### Token writes
`setTokens()` currently:
- computes `expiresAt`
- persists the singleton row to `token_set`
- preserves the existing `refresh_token` if provider response omits it
- updates in-memory cache
- schedules refresh if stream is live

#### Alarm behavior
`alarm()` currently:
- reloads the token from DB (not cache)
- skips if stream is offline
- refreshes once
- on success clears `alarmRetryCount`
- on retryable network error schedules exponential backoff retry:
  - 60s
  - 120s
  - 240s
- after max retries schedules fallback in 10 minutes
- persists retry count in raw storage so it survives hibernation

---

## Current external consumers to preserve

### OAuth setup path
`apps/api/src/routes/oauth.ts`
- Twitch OAuth callback stores tokens via `getStub("TWITCH_TOKEN_DO").setTokens(tokens)`
- Preserve this behavior and signature

### Twitch API service
`apps/api/src/services/twitch-service.ts`
- `getValidToken()` is used as the source of user access tokens for Twitch API calls
- Preserve Result-based behavior and error types

### Stream lifecycle integration
`apps/api/src/durable-objects/stream-lifecycle-do.ts`
- notifies this DO on stream online/offline
- preserve:
  - `onStreamOnline()`
  - `onStreamOffline()`

### Worker typing / namespace binding
- `apps/api/src/index.ts`
- `apps/api/wrangler.jsonc`
- `apps/api/worker-configuration.d.ts`

These likely should not need behavioral changes, but do not break typed namespace exports.

---

## Recommended Agent migration design

## 1. Make Agent state the single source of truth for current token state

This DO has **no meaningful historical/query-oriented data**. That means the natural end-state is:

### Agent state
Authoritative current state should live in Agent state, e.g.:

```ts
interface TwitchTokenAgentState {
  token: {
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresAt: string;
    expiresIn: number;
  } | null;
  isStreamLive: boolean;
  refreshScheduleId: string | null;
  refreshRetryCount: number;
}
```

Exact shape can vary, but the important rule is:

- **one authoritative current-state representation**
- no long-term dual-write to both Agent state and `token_set`

### Derived / transient only
Keep these process-local only:
- `refreshPromise`

That value is inherently transient and should **not** be persisted.

### SQLite / Drizzle
Use Drizzle only for a **one-time legacy migration read** from `token_set`.

Preferred end-state after migration:
- no ongoing reads from `token_set`
- no ongoing writes to `token_set`
- no raw `alarmRetryCount` storage key

---

## 2. Move bootstrap into `onStart()`

Follow the migration guide pattern exactly:

```ts
async onStart(): Promise<void> {
  await this.ctx.blockConcurrencyWhile(async () => {
    await migrate(this.legacyDb, migrations);
    await this.migrateLegacyStateOnce();
    await this.restoreOrRecomputeRefreshSchedule();
  });
}
```

### `onStart()` responsibilities
- initialize any legacy Drizzle access needed for migration
- run legacy schema migrations so reading old state is safe on fresh objects
- hydrate Agent state from legacy `token_set` if Agent state is empty and legacy row exists
- clear legacy alarm state (`deleteAlarm()` and `alarmRetryCount`) so Agent scheduling becomes the only scheduler
- restore or recompute the desired next refresh schedule from Agent state
- if token is live and already inside the refresh window, either:
  - refresh immediately, or
  - schedule an immediate one-shot refresh task

### Important rule
Do **not** keep constructor-time migrations / startup logic as the real source of initialization.

A constructor is fine only for cheap field setup. Bootstrap/migration work belongs in `onStart()`.

---

## 3. Replace raw alarms with Agent scheduling

This DO should **not** use `scheduleEvery()`.

### Why `scheduleEvery()` is the wrong fit here
Refresh timing is based on a moving absolute deadline (`expiresAt`) plus retry backoff behavior. The next wake-up time changes every time tokens rotate.

### Preferred design
Use **one-shot** Agent scheduling via `schedule()`.

Suggested model:
- store the current schedule id in Agent state (`refreshScheduleId`)
- when tokens change or stream live state changes:
  - cancel old schedule if needed
  - compute exact next run time
  - create a new one-shot schedule
  - persist the new schedule id

### Suggested scheduled callback responsibilities
A scheduled refresh callback should:
1. exit early if no token or stream offline
2. attempt one refresh
3. on success:
   - reset retry count to 0
   - let `setTokens()` compute and schedule the next refresh
4. on retryable `TokenRefreshNetworkError`:
   - increment retry count in Agent state
   - schedule the next backoff attempt
5. on non-retryable parse/schema errors:
   - do not exponential-backoff forever
   - schedule fallback retry in 10 minutes (matching current behavior)

### Existing timing behavior to preserve
- refresh buffer: `5 minutes before expiry`
- exponential retry base delay: `60 seconds`
- max retries: `3`
- fallback delay after exhaustion / non-retryable failure: `10 minutes`

---

## 4. Preserve the public RPC contract

Do **not** add `onRequest()` unless a real compatibility HTTP surface appears. This DO is RPC-only today.

Do **not** add browser/client `@callable()` features. They are unnecessary here.

Keep these methods and their semantics:
- `onStreamOnline()`
- `onStreamOffline()`
- `getValidToken()`
- `setTokens()`

Continue using:
- `@rpc`
- `Result<T, E>`
- the existing error types from `apps/api/src/lib/errors.ts`

---

## 5. Do a one-time legacy migration only

The migration guide strongly recommends against ongoing compatibility sync.

### Preferred migration behavior
On first start after the Agent conversion:
1. run legacy token schema migrations
2. read the old singleton `token_set` row
3. if Agent state is empty and legacy row exists, copy it into Agent state
4. clear legacy alarm state
5. optionally delete the legacy `token_set` row after successful hydration
6. from that point on, use Agent state only

### Important
Do **not** keep forever doing:
- read from Agent state and DB
- write to Agent state and DB
- reconcile them on every startup

One-time migration is the correct pattern.

---

## 6. Recommended method-by-method target behavior

### `initialState`
Define explicit initial state for the no-token case.

### `onStart()`
- run migration/bootstrap under `blockConcurrencyWhile`
- migrate legacy token row once if needed
- clear legacy alarm + retry storage
- restore/cancel the correct schedule

### `onStreamOnline()`
- set `isStreamLive = true` in Agent state
- if token exists and is inside refresh window, refresh immediately
- otherwise schedule the next refresh based on `expiresAt`
- if there is no token yet, do not crash; preserve current semantics

### `onStreamOffline()`
- set `isStreamLive = false`
- cancel any pending refresh schedule
- reset retry count
- do not delete tokens

### `getValidToken()`
- read from Agent state, not from DB/cache split
- if token valid, return it
- if no token, return `StreamOfflineNoTokenError`
- if expired and stream offline, return `StreamOfflineNoTokenError`
- if expired and stream live, refresh
- keep concurrent refresh coalescing with `refreshPromise`

### `setTokens()`
- preserve current refresh-token retention behavior when provider omits `refresh_token`
- compute `expiresAt`
- update Agent state only
- if stream is live, compute/schedule the next refresh
- if stream is offline, leave schedule cancelled

### scheduled refresh handler
- replaces `alarm()` entirely
- uses Agent schedule ids, not `ctx.storage.setAlarm()` / `deleteAlarm()`

---

## Recommended cleanup during migration

Delete or stop using these old patterns in `TwitchTokenDO`:
- `extends DurableObject<Env>`
- constructor-owned migration/bootstrap logic
- `tokenCache` as an authoritative persisted-state mirror
- raw `ctx.storage.setAlarm()` / `deleteAlarm()`
- raw `alarmRetryCount` storage key
- ongoing dependency on `token_set` as the live source of truth

Keep only this transient process-local state if still useful:
- `refreshPromise`

---

## Testing guidance

## Existing tests to preserve and adapt
File:
- `apps/api/src/__tests__/durable-objects/twitch-token-do.test.ts`

Current tests already cover useful public behavior:
- `setTokens()` persistence behavior
- refresh-token retention when refresh response omits `refresh_token`
- `getValidToken()` success/error cases
- online/offline transitions
- concurrent refresh coalescing
- refresh error handling
- persistence across DO instances

### Testing rules from repo + migration guide
- use `runInDurableObject(...)`
- use `fetchMock` only for external Twitch HTTP boundaries
- do **not** add `vi.mock()`
- do **not** add test-only dependency injection to production code
- do **not** add env override hacks to `getStub()` just for tests

### Suggested test updates/additions
Keep tests focused on public behavior, but update them for Agent lifecycle/scheduling:

1. **initial / empty state behavior still works**
   - no token -> `StreamOfflineNoTokenError`

2. **online transition triggers refresh when needed**
   - expired token + stream online -> refresh succeeds

3. **offline transition cancels future refresh work**
   - no background refresh should continue after offline

4. **concurrent refresh coalescing still works**
   - `refreshPromise` behavior preserved

5. **scheduled refresh callback behavior**
   - cover one success path
   - cover retryable network failure path
   - cover non-retryable parse failure path

6. **legacy migration on restart**
   - if feasible in worker tests, validate that state survives instance restart and still serves valid tokens
   - if directly testing legacy-row hydration is too harness-specific, at minimum verify observable persistence/restart behavior

7. **no regression for refresh-token retention**
   - provider omits `refresh_token`, previous refresh token survives

### Validation commands
Run at minimum:

```bash
pnpm --filter cf-twitch-api exec vitest run src/__tests__/durable-objects/twitch-token-do.test.ts
pnpm --filter cf-twitch-api run typecheck
```

Optionally also run the twin token tests to avoid drifting shared assumptions:

```bash
pnpm --filter cf-twitch-api exec vitest run src/__tests__/durable-objects/spotify-token-do.test.ts
```

---

## Acceptance criteria

1. `TwitchTokenDO` extends `Agent<Env, TwitchTokenAgentState>`
2. Bootstrap/migration logic lives in `onStart()` with `ctx.blockConcurrencyWhile(...)`
3. Current token state has a **single** source of truth in Agent state
4. `alarm()` is removed
5. raw `ctx.storage.setAlarm()` / `deleteAlarm()` usage is removed from this DO
6. proactive refresh uses Agent scheduling APIs
7. public RPC methods and Result/error behavior remain compatible:
   - `onStreamOnline()`
   - `onStreamOffline()`
   - `getValidToken()`
   - `setTokens()`
8. no test-only production hooks are introduced
9. targeted Twitch token tests pass
10. typecheck passes
11. legacy compatibility is one-time only, not permanent dual-write / dual-read

---

## Open questions to resolve during implementation

1. **Should `expiresIn` remain in Agent state?**
   - It is not strictly required once `expiresAt` exists.
   - Keeping it may ease parity with current `TokenSet` shape.
   - Either is fine; avoid duplicate truth.

2. **Should the legacy `token_set` row be deleted after hydration?**
   - Preferred: yes, delete it after successful migration.
   - Acceptable fallback: stop reading/writing it after startup if deletion is awkward.

3. **How should scheduled callback be exposed for tests?**
   - Prefer validating scheduled behavior via a real scheduled/public method, not private internals.
   - Do not add artificial test seams.

4. **Should shared token logic be abstracted with Spotify now?**
   - Default answer: no.
   - First land Twitch cleanly, then evaluate whether shared helpers are genuinely justified.

---

## Key implementation warning

Do **not** let this migration drift into a general token-DO refactor. The main goal is:

- migrate `TwitchTokenDO` to Agent cleanly
- establish the right pattern for token-like DOs
- preserve public behavior
- avoid long-lived compatibility baggage

Once this lands, `SpotifyTokenDO` should be much easier.
