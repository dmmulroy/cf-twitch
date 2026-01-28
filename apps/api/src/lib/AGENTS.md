# Lib Utilities

Shared helpers: DO stubs, errors, sagas, logging. See root AGENTS.md for project conventions.

## Files

| File | Lines | Status |
|------|-------|--------|
| `errors.ts` | 504 | Active |
| `durable-objects.ts` | 266 | Active (47 call sites) |
| `saga-runner.ts` | 696 | Active |
| `logger.ts` | 67 | Active (42 call sites) |
| `exhaustive.ts` | 102 | Active |
| `cache.ts` | 63 | Active |
| `analytics.ts` | 231 | Partial - only `writeSagaLifecycleMetric`, `writeChatCommandMetric` used |

## Key Patterns

### getStub() - Typed DO Access

```typescript
import { getStub } from "~/lib/durable-objects";

const stub = getStub("SPOTIFY_TOKEN_DO");           // singleton
const stub = getStub("SONG_REQUEST_SAGA_DO", id);   // keyed by ID

const result = await stub.getAccessToken();  // Result<T, E | DurableObjectError>
```

Auto-deserializes `Result` values, wraps infra errors in `DurableObjectError`.

### Error Type Guards

```typescript
import { SpotifyRateLimitError, isRetryableError } from "~/lib/errors";

if (SpotifyRateLimitError.is(error)) {
  // error narrowed to SpotifyRateLimitError
}
if (isRetryableError(error)) { /* rate limit or 5xx */ }
```

### SagaRunner - Step Execution

```typescript
class MySagaDO extends DurableObject {
  private runner: SagaRunner;
  
  async runStep() {
    return this.runner.executeStepWithRollback(
      "step-name",
      async () => ({ result: data, undoPayload: rollbackData }),
      async (payload) => { /* compensation */ }
    );
  }
}
```

### Exhaustive Checks

```typescript
import { casesHandled } from "~/lib/exhaustive";

function handle(cmd: "song" | "queue") {
  if (cmd === "song") return handleSong();
  if (cmd === "queue") return handleQueue();
  return casesHandled(cmd);  // TS error if case missing
}
```

## Dead Code

| File | Items |
|------|-------|
| `analytics.ts` | `writeSongRequestMetric`, `writeRaffleRollMetric`, `writeErrorMetric`, `writeAchievementUnlockMetric` |
