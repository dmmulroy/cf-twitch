# Lib Utilities

Shared helpers for cf-twitch-api. See root AGENTS.md for conventions.

## Files

| File                 | Purpose                           | Status |
| -------------------- | --------------------------------- | ------ |
| `durable-objects.ts` | `getStub()`, Result serialization | Active |
| `errors.ts`          | TaggedError types                 | Active |
| `warm-workflow.ts`   | Warm pool activation helpers      | Active |
| `logger.ts`          | Structured JSON logger            | Active |
| `cache.ts`           | Cache utilities                   | Active |
| `exhaustive.ts`      | Exhaustive switch helper          | Active |
| `analytics.ts`       | Typed metric writers              | Unused |

## durable-objects.ts

Core utilities for DO interaction:

```typescript
import { getStub } from "~/lib/durable-objects";

// Type-safe stub with Result deserialization
const stub = getStub(env, "SPOTIFY_TOKEN_DO");
const result = await stub.getValidToken(); // Result<string, TokenError>
```

**Key exports:**

- `getStub(env, key)` - Typed stub retrieval with singleton ID mapping
- `withResultSerialization(Class)` - DO wrapper for RPC Result serialization
- `SINGLETON_IDS` - DO name → singleton ID mapping

## errors.ts

All errors extend `TaggedError` from better-result:

```typescript
export class MyError extends TaggedError {
	readonly _tag = "MyError" as const;
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}
```

**Active errors:** `TokenRefreshError`, `DurableObjectError`

Use `MyError.is(error)` for type narrowing (not `instanceof`).

## warm-workflow.ts

Helpers for warm workflow pool pattern:

```typescript
import { waitForActivation, triggerWarmWorkflow } from "~/lib/warm-workflow";

// In workflow: wait for activation event
const params = await waitForActivation<MyParams>(step);

// From caller: activate warm instance or start cold
const handle = await triggerWarmWorkflow(env.WORKFLOW_POOL_DO, env.MY_WF, params);
```

## logger.ts

Structured JSON logger:

```typescript
import { logger } from "~/lib/logger";

logger.info("Processing", { userId: "123" });
logger.error("Failed", { error: err.message });
```

Output: `{"level":"info","message":"...","timestamp":"2026-01-25T...","userId":"123"}`
