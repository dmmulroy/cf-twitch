# Lib Utilities

Shared helpers for the cf-twitch-api worker. See root AGENTS.md for project conventions.

## Files

| File                                   | Lines | Status           |
| -------------------------------------- | ----- | ---------------- |
| `errors.ts`                            | 118   | Active (partial) |
| `do-ids.ts`                            | 39    | Active           |
| `analytics.ts`                         | 96    | Unused           |
| `logger.ts`                            | 67    | Active           |
| `stub-with-better-result-hydration.ts` | 81    | Unused           |

## errors.ts

All errors extend `TaggedError` from better-result with `readonly _tag` discriminant.

| Error                | Tag                    | Status                                             |
| -------------------- | ---------------------- | -------------------------------------------------- |
| `TokenRefreshError`  | `"TokenRefreshError"`  | **Active** (8 call sites)                          |
| `DurableObjectError` | `"DurableObjectError"` | Unused (only in stub-with-better-result-hydration) |
| `SpotifyError`       | `"SpotifyError"`       | **DEAD CODE**                                      |
| `TwitchError`        | `"TwitchError"`        | **DEAD CODE**                                      |
| `InvalidSpotifyUrl`  | `"InvalidSpotifyUrl"`  | **DEAD CODE**                                      |
| `ValidationError`    | `"ValidationError"`    | **DEAD CODE**                                      |

Helper functions:

- `isRetryableError(error)` - Check if error is transient (rate limit, network)
- `requiresTokenRefresh(error)` - Check if error indicates expired token

### Adding New Errors

```typescript
export class MyNewError extends TaggedError {
	readonly _tag = "MyNewError" as const;
	constructor(
		public readonly field: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}
```

## do-ids.ts

Singleton DO IDs for all DOs. Use `getDOStub()` helper to get typed stubs.

```typescript
import { DO_IDS, getDOStub } from "~/lib/do-ids";

const stub = getDOStub(env.SPOTIFY_TOKEN_DO, DO_IDS.SPOTIFY_TOKEN);
```

**Active** - 8 call sites across oauth.ts, stream-lifecycle-do.ts, twitch-service.ts

## analytics.ts

Type-safe metric writers for Analytics Engine.

```typescript
writeSongRequestMetric(env.ANALYTICS, {
	requester: "user123",
	trackId: "spotify:track:xxx",
	trackName: "Song Name",
	status: "fulfilled",
	latencyMs: 150,
});
```

Metric types: `SongRequestMetric`, `RaffleRollMetric`, `ErrorMetric`

**Status:** Typed functions are **UNUSED**. Tail worker uses raw `writeDataPoint()` directly.

## logger.ts

Structured JSON logger with levels.

```typescript
import { logger } from "~/lib/logger";

logger.info("Processing request", { userId: "123" });
logger.error("Failed to fetch", { error: err.message });
```

Output: `{"level":"info","message":"...","timestamp":"2026-01-14T...","userId":"123"}`

**Active** - 42 call sites across all modules

## stub-with-better-result-hydration.ts

Wrapper for DO stubs to enable Result pattern.

```typescript
import { stubWithBetterResultHydration } from "~/lib/stub-with-better-result-hydration";

const stub = env.MY_DO.get(id);
const wrapped = stubWithBetterResultHydration(stub);
const result = await wrapped.myMethod(); // Result<T, E | DurableObjectError>
```

Features:

- Catches DO infrastructure errors -> `DurableObjectError`
- Calls `Result.hydrate()` on return values
- Wraps non-Result returns in `Result.ok()`

**Status:** **UNUSED** - Prepared for Result pattern migration. DO methods currently throw instead of returning `Result<T, E>`.

## Anti-Patterns

- **Don't** throw errors from RPC methods - return `Result.err()`
- **Don't** use raw `writeDataPoint()` in api worker - use typed metric functions
- **Don't** define error classes without using them - delete or implement
