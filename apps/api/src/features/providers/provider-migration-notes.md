# Provider and OAuth implementation notes

## Public owners

- `TwitchService` / `twitchServiceLayer`: Helix stream information, chat delivery evidence, shoutouts, redemption status, and bounded complete EventSub pagination.
- `SpotifyService` / `spotifyServiceLayer`: track metadata, concurrent playback observations, active devices, queue append/skip and internal Connect compensation.
- `ProviderAccessTokens` / `providerAccessTokensLayer`: HTTP-only token Durable Object clients. Physical classes remain `SpotifyTokenDO` and `TwitchTokenDO`; singleton names remain `spotify-token` and `twitch-token`.
- `OAuthAuthorization` / `oauthAuthorizationLayer`: secure UUID state creation, exact provider/redirect binding, separate consumption before provider-denial/code handling, and exchange followed by durable token acceptance.
- `OAuthStateServer`: physical class `OAuthStateDO`; object name remains the UUID state. Native key `authorization-attempt` and `consumedAtMs` remain compatible.

All ready layers leave runtime HTTP/configuration/crypto requirements visible. Dependency-preserving token server layers additionally leave `ProviderTokenExchange` visible. SQL/native storage acquisition happens only inside Alchemy's returned runtime Effect. Clients allocate invocation-local HTTP clients with `makeExecutionMemo`; only multi-state OAuth uses a bounded Cache.

Provider HTTP owns protocol/error translation; token exchange is independent of stream-aware user-token access to avoid a refresh dependency cycle. SQL owns credentials and alarm intent, lifecycle owns refresh serialization and scheduling, and OAuth native transactions own one-use state.

## Refresh and mutation guarantees

- Access tokens are usable only before `expiresAt - 5 minutes`, including offline. An expired/inside-buffer offline token never causes provider I/O.
- Live refresh is single-flight via `Effect.cachedWithTTL(..., 0)`. The refresh lock rechecks expiry after acquisition, closing the stale pre-lock-read race.
- Successful responses retain an existing refresh token when rotation is omitted. Credentials stay `Redacted` outside final SQL/HTTP serialization.
- Alarm intent is persisted before native scheduling and repaired during runtime acquisition. Network failures schedule 1, 2, 4 minutes, then a 10-minute fallback. Malformed successes use the 10-minute fallback. Revocation/missing refresh credentials persist reauthorization-required and cancel scheduling.
- No unknown provider mutation outcome is retried internally. Network loss, 5xx, malformed delivery evidence, and undocumented bodyless success statuses become `outcome-unknown`.
- Spotify compensation refuses (`false`) when multiple queue entries have the same URI: a track ID cannot establish which occurrence belongs to the failed request. It never removes every matching occurrence. The workflow retains failed compensation rather than claiming rollback.
- Playback queue failure never returns an empty replacement snapshot. Queue and current-playing requests run concurrently; only current-playing typed failure falls back to the successful queue's current track.
- Default HTTP tracing is disabled at the outbound provider boundary before collection. Named operation spans contain only safe provider/operation fields. Errors/logs omit raw requests, credentials, provider bodies and decode/storage causes.

## Historical token import

Source verified against `agents@0.9.0`, commit `806579ac0fc38aeea93ce160731ac5cfd082abfe`, `packages/agents/src/index.ts`:

- `cf_agents_state(id TEXT PRIMARY KEY NOT NULL, state TEXT)` stores `JSON.stringify(state)` at `cf_state_row_id`.
- Baseline version-1 JSON contains `version`, nullable `token`, `isStreamLive`, `authorizationStatus`, `refreshScheduleId`, and `refreshRetryCount`. The token contains `accessToken`, `refreshToken`, `tokenType`, `expiresIn`, and `expiresAt`. The unversioned representation omits `version` and `authorizationStatus`. Both decode explicitly, retaining offset ISO expiries, rotated refresh tokens, live state, authorization status and retry count.
- Existing `cf_agents_schedules` rows addressed by `refreshScheduleId` must be scheduled/delayed `refreshTokenTick` work. `time` is Unix **seconds**, converted exactly to the new millisecond alarm intent. A present schedule ID with no schedule table or exact valid row fails closed; proactive work is recomputed from expiry with a one-second minimum only when the legacy state has no schedule ID.
- Destination is `provider_token_state`, migrated with `SqliteMigrator`. Source evidence is parsed before destination creation. Import never deletes/updates Agent state or schedules. A populated destination is authoritative on subsequent restarts and is not re-imported.
- Missing application state, malformed JSON/token/schedule evidence, unknown versions or inconsistent authorization state fail closed as `ProviderError` with operation `LegacyAgentStateImportRequired`. They never reset credentials.
- Native OAuth `authorization-attempt` holds `state`, `provider`, `redirectUri`, `createdAtMs`, `expiresAtMs`, and `consumedAtMs`; it is not translated into SQL. Creation and consumption use native storage transactions; alarms delete only the expiring authorization-attempt key.

A process crash after an upstream rotates a refresh token but before local persistence is an external transaction gap; retain uncertainty instead of inventing provider idempotency. The [acceptance ledger](../../../../../docs/capability-parity.md#providers-and-oauth) records native limits; the [production gate](../../../../../docs/production-cutover.md) owns adoption approval.

## Verification

Use the [focused verification procedure](../../../../../docs/verification.md#focused-feedback) with `src/features/providers src/features/oauth`. [Recorded verification](../../../../../docs/verification.md#recorded-verification) owns dated test results.

- [Token migration](provider-token-migration.test.ts) and [database](provider-token-database.test.ts): actual SQLite source/import/reconstruction/failure and legacy schedule evidence.
- [Token lifecycle](provider-token-lifecycle.test.ts) and [exchange](provider-token-exchange.test.ts): concurrent refresh barriers, rotation, retry deadlines and refusal/uncertain outcomes through controlled HTTP.
- [Spotify](spotify-service.test.ts), [Twitch](twitch-service.test.ts), [subscriptions](twitch-subscriptions.test.ts), and [HTTP security](provider-http-security.test.ts): provider operations, pagination limits and secret-safe tracing.
- [OAuth contract](../oauth/oauth-contract.test.ts): application-owned redirect/UUID constraints.

The local SQL alarm register stores actual deadlines; tests invoke its public callback explicitly and control backoff with TestClock. This is not native timer-delivery evidence. Consult the [native evidence index](../../../../../docs/capability-parity.md#acceptance-status) before claiming namespace/eviction coverage.
