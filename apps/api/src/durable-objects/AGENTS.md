# Durable Objects

Token management and stream lifecycle DOs. See root AGENTS.md for project conventions.

## Overview

| DO                  | Purpose                               | Lines | Status      |
| ------------------- | ------------------------------------- | ----- | ----------- |
| `SpotifyTokenDO`    | OAuth token storage + refresh         | ~200  | Implemented |
| `TwitchTokenDO`     | OAuth token storage + refresh         | ~200  | Implemented |
| `StreamLifecycleDO` | Stream state, viewer tracking, alarms | ~370  | Implemented |
| `SongQueueDO`       | Song request queue                    | -     | Stub (501)  |
| `AchievementsDO`    | Achievement tracking                  | -     | Stub (501)  |
| `KeyboardRaffleDO`  | Raffle system                         | -     | Stub (501)  |

## Schemas

- `schemas/token-schema.ts` - Shared token table schema for both token DOs
- `stream-lifecycle-do.schema.ts` - Stream state + viewer snapshots tables

## Token DO Pattern

Both token DOs follow identical pattern:

- Singleton row (`id = 1`)
- In-memory cache + SQLite persistence via Drizzle
- Coalesced refresh (single inflight promise via `refreshPromise`)
- Stream lifecycle hooks (`onStreamOnline`/`onStreamOffline`)
- 5-minute refresh buffer before expiry

```typescript
// Correct Drizzle init in constructor
this.db = drizzle(this.ctx.storage, { schema });
```

### RPC Methods

| Method              | Returns           | Purpose                      |
| ------------------- | ----------------- | ---------------------------- |
| `getValidToken()`   | `Promise<string>` | Get token, refresh if needed |
| `setTokens(tokens)` | `Promise<void>`   | Store new OAuth tokens       |
| `onStreamOnline()`  | `Promise<void>`   | Stream started callback      |
| `onStreamOffline()` | `Promise<void>`   | Stream ended callback        |

## StreamLifecycleDO

- **Alarms**: 60s viewer count polling when live
- **WebSockets**: Broadcasts `stream_online`/`stream_offline` events via hibernation API
- **Tables**: `stream_state` (singleton), `viewer_snapshots` (timeseries)
- **DO-to-DO**: Signals token DOs on lifecycle changes via RPC

### RPC Methods

| Method                             | Returns                  | Purpose                                        |
| ---------------------------------- | ------------------------ | ---------------------------------------------- |
| `onStreamOnline()`                 | `Promise<void>`          | Initialize stream, notify token DOs, set alarm |
| `onStreamOffline()`                | `Promise<void>`          | End stream, notify token DOs, cancel alarm     |
| `getStreamState()`                 | `Promise<StreamState>`   | Return current stream state                    |
| `getIsLive()`                      | `Promise<boolean>`       | Return boolean live status                     |
| `getViewerHistory(since?, until?)` | `Promise<{snapshots}>`   | Return viewer count snapshots                  |
| `recordViewerCount(count)`         | `Promise<void>`          | Record viewer snapshot, update peak            |
| `ping()`                           | `Promise<{ok: boolean}>` | Health check                                   |

## Pattern Violations (Need Fix)

### fetch() Handler (line 269-330)

StreamLifecycleDO has `fetch()` handler with switch routing. Should expose RPC methods directly.

```typescript
// CURRENT (bad)
switch (url.pathname) {
  case "/stream-online": await this.onStreamOnline(); ...
}

// TARGET (good) - remove fetch handler, callers use RPC:
stub.onStreamOnline()
```

### throw Instead of Result

All DOs throw instead of returning `Result<T, E>`:

```typescript
// CURRENT (bad)
throw new TokenRefreshError("No token available");

// TARGET (good)
return Result.err(new TokenRefreshError("No token available"));
```

### Type Cast at IO Boundary (line 288)

```typescript
// CURRENT (bad)
const { count } = (await request.json()) as { count: number };

// TARGET (good)
const body = RecordViewerCountBody.parse(await request.json());
```

### Token DOs Bypass Services

Token DOs call external APIs directly via `fetch()` instead of using service bindings:

```typescript
// CURRENT (bad) - spotify-token-do.ts:159
const response = await fetch("https://accounts.spotify.com/api/token", ...);

// TARGET (good) - use service binding
const result = await this.env.SPOTIFY_SERVICE.refreshToken(refreshToken);
```

## Anti-Patterns

- **Don't** use `this.sql.exec()` directly - use Drizzle ORM
- **Don't** call other DOs via `stub.fetch()` - use RPC methods
- **Don't** store timestamps as INTEGER epoch - use TEXT ISO8601
- **Don't** fetch external APIs directly - use service bindings
- **Don't** throw errors in RPC methods - return `Result.err()`
