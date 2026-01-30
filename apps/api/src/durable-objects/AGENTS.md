# Durable Objects

8 DOs for OAuth tokens, stream lifecycle, song queue, achievements, raffles, and sagas.

## Durable Objects

| DO                     | Lines | Key Pattern                                                      |
| ---------------------- | ----- | ---------------------------------------------------------------- |
| `SpotifyTokenDO`       | 432   | Singleton, in-memory cache + SQLite, coalesced `refreshPromise`  |
| `TwitchTokenDO`        | 433   | Same pattern as SpotifyTokenDO                                   |
| `StreamLifecycleDO`    | 409   | Alarms (60s polling), WebSocket hibernation, signals token DOs   |
| `SongQueueDO`          | 932   | 3-phase sync algorithm, `ensureFresh()` with stale fallback      |
| `AchievementsDO`       | 543   | Event-driven progress, session/cumulative scope, `recordEvent()` |
| `KeyboardRaffleDO`     | 266   | Roll recording, leaderboard via SQLite view                      |
| `SongRequestSagaDO`    | 610   | Extends `SagaRunner`, 7-step flow with PONR at step 6            |
| `KeyboardRaffleSagaDO` | 483   | Extends `SagaRunner`, 5-step flow with PONR at step 4            |

## Patterns

### Token DOs (Spotify/Twitch)

- Singleton row (`id = 1`), `refreshPromise` coalesces concurrent refreshes
- `StreamLifecycleHandler` interface: `onStreamOnline()` / `onStreamOffline()`
- Proactive alarm refresh 5min before expiry when stream is live

### SongQueueDO Sync Algorithm

```
1. Build per-trackId pools from pending requests (FIFO)
2. Fetch Spotify currently_playing + queue
3. Attribute: pop oldest pending match → source='user' | else → 'autoplay'
4. reconcilePlayed(): if position 0 changed, move eventId to history
5. reconcileDropped(): delete pending that were seen but disappeared
6. cleanupStalePending(): TTL 1 hour
```

### Saga DOs

- `SagaRunner` from `lib/saga-runner.ts` handles step execution/retry/compensation
- `executeStep()` for non-rollbackable, `executeStepWithRollback()` for rollbackable
- `markPointOfNoReturn()` after fulfill step - no compensation after
- Alarms resume execution on retry

## Schemas

| Location                               | Tables                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| `schemas/token-schema.ts`              | `token_set` (shared by both token DOs)                          |
| `schemas/saga.schema.ts`               | `saga_runs`, `saga_steps` (shared by saga DOs)                  |
| `schemas/song-queue-do.schema.ts`      | `pending_requests`, `request_history`, `spotify_queue_snapshot` |
| `schemas/achievements-do.schema.ts`    | `achievement_definitions`, `user_achievements`                  |
| `schemas/keyboard-raffle-do.schema.ts` | `rolls`, `raffle_leaderboard` (view)                            |
| `stream-lifecycle-do.schema.ts`        | `stream_state`, `viewer_snapshots` (orphan - should move)       |

## Violations

### fetch() Handler

- `StreamLifecycleDO:247-314` - Has `fetch()` with switch routing, should use RPC directly

### Type Casts

- `stream-lifecycle-do.ts:125,394` - `as WebSocket[]` (CF types issue)

### Schema Location

- `stream-lifecycle-do.schema.ts` - Orphan in root, should be in `schemas/`
