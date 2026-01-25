# Durable Objects

Token management, stream lifecycle, and feature DOs. See root AGENTS.md for conventions.

## Overview

| DO                  | Purpose                           | Schema Location                        |
| ------------------- | --------------------------------- | -------------------------------------- |
| `SpotifyTokenDO`    | OAuth token storage + refresh     | `schemas/token-schema.ts`              |
| `TwitchTokenDO`     | OAuth token storage + refresh     | `schemas/token-schema.ts`              |
| `StreamLifecycleDO` | Stream state, viewer tracking     | `stream-lifecycle-do.schema.ts`        |
| `SongQueueDO`       | Song request queue + Spotify sync | `schemas/song-queue-do.schema.ts`      |
| `AchievementsDO`    | Per-user achievement tracking     | `schemas/achievements-do.schema.ts`    |
| `KeyboardRaffleDO`  | Raffle rolls + leaderboard        | `schemas/keyboard-raffle-do.schema.ts` |
| `WorkflowPoolDO`    | Warm workflow instance management | `schemas/workflow-pool-do.schema.ts`   |

## Common Pattern

All DOs follow:

```typescript
export class MyDO extends DurableObject<Env> {
	private db: Drizzle;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });
		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	// ALL public methods return Result<T, E>
	async myMethod(): Promise<Result<T, MyError>> {
		return Result.ok(value);
	}
}
```

## Token DOs

Shared pattern for `SpotifyTokenDO` and `TwitchTokenDO`:

- Singleton row (`id = 1`)
- In-memory cache + SQLite persistence
- Coalesced refresh via `refreshPromise`
- 5-minute buffer before expiry triggers refresh
- Implements `StreamLifecycleHandler` interface

## StreamLifecycleDO

- **Alarms**: 60s polling for viewer count when live
- **WebSockets**: Hibernation API, broadcasts `stream_online`/`stream_offline`
- **DO-to-DO**: Signals token DOs on lifecycle changes via RPC

**Pattern Violation**: Has `fetch()` handler (lines 247-314) with if/else routing. Use RPC methods instead.

## SongQueueDO

- `ensureFresh()` pattern with backoff + stale fallback
- Reconciles played/dropped tracks with Spotify
- Pending → History tracking

## WorkflowPoolDO

- Manages pre-warmed workflow instances (pool size: 3)
- Warm instances wait at `step.waitForEvent("activate")`
- `triggerWarmWorkflow()` activates or falls back to cold start

## Export Pattern

All DOs wrapped in `index.ts`:

```typescript
export const MyDO = withResultSerialization(MyDOBase);
```

This enables Result serialization across RPC boundary.
