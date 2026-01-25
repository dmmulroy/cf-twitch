# Tests

Vitest tests with Cloudflare Workers pool. See root AGENTS.md for conventions.

## Structure

```
__tests__/
├── setup.ts              # Global fetchMock setup
├── cloudflare-test.d.ts  # Type declarations
├── fixtures/
│   ├── spotify.ts        # Spotify mock helpers
│   ├── twitch.ts         # Twitch mock helpers
│   └── song-request.ts   # Factory functions
└── durable-objects/
    ├── spotify-token-do.test.ts
    ├── twitch-token-do.test.ts
    ├── stream-lifecycle-do.test.ts
    ├── song-queue-do.test.ts
    └── keyboard-raffle-do.test.ts
```

## Running Tests

```bash
pnpm test        # vitest run
pnpm test:watch  # vitest watch mode
```

## Pattern

```typescript
import { env, fetchMock, runInDurableObject, SELF } from "cloudflare:test";

describe("MyDO", () => {
	let stub: DurableObjectStub<MyDO>;

	beforeEach(async () => {
		const id = env.MY_DO.idFromName("test");
		stub = env.MY_DO.get(id);
		// Force init to complete
		await runInDurableObject(stub, async (instance) => {
			await instance.ping();
		});
	});

	it("does thing", async () => {
		// Mock external calls
		fetchMock
			.get("https://api.example.com/thing")
			.intercept({ path: "/thing" })
			.reply(200, { data: "value" });

		// Call DO method directly (RPC)
		const result = await stub.myMethod();

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBe("expected");
		}
	});
});
```

## Fixtures

Mock helpers accept `typeof fetchMock`:

```typescript
import { mockSpotifyTokenRefresh } from "./fixtures/spotify";

mockSpotifyTokenRefresh(fetchMock, { access_token: "test" });
```

Factory functions for test data:

```typescript
import { createPendingRequest } from "./fixtures/song-request";

const request = createPendingRequest({ userId: "test-user" });
```

## Known Limitations

1. **`getStub()` unavailable**: Tests using `getStub()` are skipped - uses global `env` from `cloudflare:workers` not available in vitest context

2. **DO init race**: Use `runInDurableObject` + `ping()` in beforeEach to ensure `blockConcurrencyWhile` completes

3. **Response body consumption**: Must consume response body per vitest-pool-workers requirements:

```typescript
await response.text(); // Required even if not using body
```

4. **fetch() handler tests**: Use `stub.fetch()` when testing legacy fetch handlers (e.g., StreamLifecycleDO)
