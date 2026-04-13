# Durable Object `RpcTarget` Handle Design

## Context

This design documents a proposed replacement for the current generic `wrapStub()` pattern in `apps/api/src/lib/durable-objects.ts`.

The current implementation mixes several concerns into one abstraction:

- Durable Object lookup
- Agent/bootstrap initialization
- per-method RPC interception through a `Proxy`
- `better-result` serialization/deserialization
- infrastructure error wrapping

This works, but it puts control-plane behavior on the hot data-plane path and hides native Cloudflare RPC semantics behind a generic wrapper.

This document describes a cleaner design using:

- a small public `connect()` method on each Durable Object
- a server-side `RpcTarget` handle
- a local client facade/helper
- transport-only `Result` serialization at the RPC boundary

## Goals

- Remove generic per-method `wrapStub()` interception from hot paths
- Make control-plane bootstrap explicit
- Keep `better-result`
- Hide serialization/deserialization from callers
- Preserve a simple caller API
- Align with Cloudflare Durable Object RPC and `RpcTarget` patterns

## Non-goals

- Replace `better-result` with a DTO envelope format
- Fully redesign all Durable Objects in one step
- Solve every Agent bootstrap issue globally in this document

---

## Desired caller experience

Callers should use a narrow connector/helper and get a typed client back:

```ts
using queue = await getSongQueue();
const result = await queue.getSongQueue(limit);
```

Callers should **not** manually:

- call `Result.serialize()`
- call `Result.deserialize()`
- know whether a remote call used a raw DO stub or a `RpcTarget`
- deal with generic `Proxy` wrappers

Callers should continue to receive:

```ts
Promise<Result<T, E | DurableObjectError>>;
```

---

## High-level architecture

This design has four layers.

### 1. Durable Object internals

Business logic lives in internal methods that return normal project-native values:

```ts
Promise<Result<T, E>>;
```

These methods should not know about RPC transport encoding.

### 2. Durable Object public control-plane API

The Durable Object exposes a small public method such as:

```ts
connect(name: string): Promise<SongQueueRpcHandle>
```

**Implementation note:** in this codebase, the concrete method is named `connectRpc(name)` instead of `connect(name)` because `DurableObjectStub` already inherits a built-in `connect()` method from `Fetcher` for socket connections. Using `connect()` for the RPC handle would collide with that platform API.

This method is the explicit control-plane entrypoint.

It may:

- validate or persist metadata
- ensure initialization/bootstrap has happened
- create and return a typed `RpcTarget` handle

It should not contain business query/mutation logic.

### 3. Server-side `RpcTarget` handle

The handle is the transport surface exposed over RPC.

It should be intentionally thin. Each handle method should simply map an internal `Result` into an RPC-safe payload:

```ts
return this.queue.someInternalMethod(args).then(toRpcResult);
```

The handle should not contain business logic.

### 4. Client-side facade/helper

A local client wrapper returned by `getSongQueue()`:

- calls the remote handle
- deserializes RPC transport payloads back into `Result`
- converts thrown infrastructure exceptions into `DurableObjectError`

This keeps transport details out of routes, services, and other callers.

---

## Core design rule

The design should follow this rule consistently:

- **Internal DO business methods** return `Promise<Result<T, E>>`
- **`RpcTarget` handle methods** return `Promise<SerializedResult<T, E>>`
- **Client facade methods** return `Promise<Result<T, E | DurableObjectError>>`

In other words:

- business logic stays internal
- transport serialization happens only at the RPC boundary
- transport deserialization happens only in the local client facade

---

## Transport helpers

Create a small shared module for RPC-safe `Result` transport.

### File

`apps/api/src/lib/rpc-result.ts`

### Responsibilities

- serialize a `Result` for RPC transport
- deserialize an RPC payload back into a `Result`
- wrap non-RPC or invalid payloads as `DurableObjectError`
- wrap thrown infrastructure exceptions consistently

### Sketch

```ts
import { Result } from "better-result";
import { DurableObjectError } from "./errors";

export type SerializedResult<T, E> = ReturnType<typeof Result.serialize<T, E>>;

export function toRpcResult<T, E>(result: Result<T, E>): SerializedResult<T, E> {
	return Result.serialize(result);
}

export function fromRpcResult<T, E>(
	value: unknown,
	method: string,
): Result<T, E | DurableObjectError> {
	const deserialized = Result.deserialize(value);

	if (deserialized !== null) {
		return deserialized as Result<T, E | DurableObjectError>;
	}

	return Result.err(
		new DurableObjectError({
			method,
			message: "Invalid RPC result payload",
		}),
	);
}

export function rpcInfraError(method: string, error: unknown): Result<never, DurableObjectError> {
	return Result.err(
		new DurableObjectError({
			method,
			message: error instanceof Error ? error.message : String(error),
			cause: error,
		}),
	);
}

export async function callRpcResult<T, E>(
	method: string,
	call: Promise<unknown>,
): Promise<Result<T, E | DurableObjectError>> {
	try {
		const raw = await call;
		return fromRpcResult<T, E>(raw, method);
	} catch (error) {
		return rpcInfraError(method, error);
	}
}
```

### Important note

Serialization/deserialization should remain an **internal transport detail**. Callers should not interact with these helpers directly except through a typed client facade.

---

## Example: `SongQueueDO`

`SongQueueDO` is the recommended pilot for this design because:

- it is currently a production pain point
- its route surface is small and easy to migrate
- it already has well-defined RPC methods
- it exercises the current Agent/bootstrap problem

### Public shape after refactor

Instead of callers talking directly to the DO's public business methods, they connect first:

```ts
using queue = await getSongQueue();
const result = await queue.getSongQueue(limit);
```

---

## Server-side `RpcTarget` handle

### File location

Inside `apps/api/src/durable-objects/song-queue-do.ts`

### Responsibilities

- represent the business RPC surface for the song queue
- perform transport-only serialization
- avoid business logic

### Sketch

```ts
import { RpcTarget } from "cloudflare:workers";
import { toRpcResult, type SerializedResult } from "../lib/rpc-result";

class SongQueueRpcHandle extends RpcTarget {
	constructor(private readonly queue: _SongQueueDO) {
		super();
	}

	getSongQueue(limit: number): Promise<SerializedResult<SongQueueResponse, SongQueueError>> {
		return this.queue.getSongQueueInternal(limit).then(toRpcResult);
	}

	getCurrentlyPlaying(): Promise<SerializedResult<NowPlayingResponse | null, SongQueueError>> {
		return this.queue.getCurrentlyPlayingInternal().then(toRpcResult);
	}

	getRequestHistory(
		limit: number,
	): Promise<SerializedResult<RequestHistoryResponse, SongQueueError>> {
		return this.queue.getRequestHistoryInternal(limit).then(toRpcResult);
	}

	persistRequest(request: InsertPendingRequest): Promise<SerializedResult<void, SongQueueDbError>> {
		return this.queue.persistRequestInternal(request).then(toRpcResult);
	}

	deleteRequest(eventId: string): Promise<SerializedResult<void, SongQueueDbError>> {
		return this.queue.deleteRequestInternal(eventId).then(toRpcResult);
	}

	writeHistory(
		eventId: string,
		fulfilledAt: string,
	): Promise<SerializedResult<void, SongQueueDbError | SongRequestNotFoundError>> {
		return this.queue.writeHistoryInternal(eventId, fulfilledAt).then(toRpcResult);
	}
}
```

### Key rule for handle methods

Every handle method should follow the same pattern:

```ts
return this.queue.fn(args).then(toRpcResult);
```

This keeps the handle obviously transport-focused and easy to review.

---

## Durable Object public API

The Durable Object itself exposes a small public `connect()` method.

### Sketch

```ts
class _SongQueueDO extends Agent<Env, SongQueueAgentState> {
	async connect(name: string): Promise<SongQueueRpcHandle> {
		await this.ensureConnected(name);
		return new SongQueueRpcHandle(this);
	}

	private async ensureConnected(name: string): Promise<void> {
		// Control-plane setup only.
		// Examples:
		// - validate singleton name
		// - ensure metadata/bootstrap exists
		// - persist object metadata if needed
	}
}
```

### Responsibility of `connect()`

`connect()` is the right place for:

- control-plane setup
- metadata initialization
- explicit session/handle creation

`connect()` is **not** the right place for:

- queue reads
- queue writes
- history queries
- currently playing lookups

---

## Internal business methods

The current public business methods should move to internal methods on the DO.

### Sketch

```ts
private getSongQueueInternal(
  limit: number,
): Promise<Result<SongQueueResponse, SongQueueError>> {
  // existing logic from current getSongQueue()
}

private getCurrentlyPlayingInternal(): Promise<
  Result<NowPlayingResponse | null, SongQueueError>
> {
  // existing logic from current getCurrentlyPlaying()
}

private getRequestHistoryInternal(
  limit: number,
): Promise<Result<RequestHistoryResponse, SongQueueError>> {
  // existing logic from current getRequestHistory()
}

private persistRequestInternal(
  request: InsertPendingRequest,
): Promise<Result<void, SongQueueDbError>> {
  // existing logic from current persistRequest()
}
```

### Why this split matters

This cleanly separates:

- business logic
- control-plane/session logic
- transport serialization logic

That makes the system easier to reason about and easier to evolve.

---

## Client facade

### File

`apps/api/src/lib/song-queue-client.ts`

### Responsibilities

- provide the local typed API callers use
- call the remote `RpcTarget` handle
- deserialize transport payloads internally
- wrap thrown transport/infrastructure failures as `DurableObjectError`
- optionally expose disposal by delegating to the underlying handle

### Sketch

```ts
import { callRpcResult } from "./rpc-result";

export class SongQueueClient {
	constructor(private readonly handle: SongQueueRpcHandleStub) {}

	[Symbol.dispose](): void {
		this.handle[Symbol.dispose]?.();
	}

	getSongQueue(
		limit: number,
	): Promise<Result<SongQueueResponse, SongQueueError | DurableObjectError>> {
		return callRpcResult<SongQueueResponse, SongQueueError>(
			"getSongQueue",
			this.handle.getSongQueue(limit),
		);
	}

	getCurrentlyPlaying(): Promise<
		Result<NowPlayingResponse | null, SongQueueError | DurableObjectError>
	> {
		return callRpcResult<NowPlayingResponse | null, SongQueueError>(
			"getCurrentlyPlaying",
			this.handle.getCurrentlyPlaying(),
		);
	}

	getRequestHistory(
		limit: number,
	): Promise<Result<RequestHistoryResponse, SongQueueError | DurableObjectError>> {
		return callRpcResult<RequestHistoryResponse, SongQueueError>(
			"getRequestHistory",
			this.handle.getRequestHistory(limit),
		);
	}

	persistRequest(
		request: InsertPendingRequest,
	): Promise<Result<void, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<void, SongQueueDbError>(
			"persistRequest",
			this.handle.persistRequest(request),
		);
	}
}
```

### Important property of this design

Routes and services call the `SongQueueClient`, not the raw `RpcTarget` handle and not the raw DO stub.

This keeps transport details hidden without bringing back a universal `wrapStub()` proxy.

### Why have both `SongQueueRpcHandle` and `SongQueueClient`?

They _can_ be collapsed into one class if we want a smaller design. The reason to keep them separate is that they live on opposite sides of the RPC boundary and have different responsibilities:

- `SongQueueRpcHandle` is the **server-side remote object** returned by the Durable Object. It should stay very thin and only do transport mapping:
  ```ts
  return this.queue.fn(args).then(toRpcResult);
  ```
- `SongQueueClient` is the **local caller-facing API** used by routes and services. It hides deserialization, infra error wrapping, and disposal delegation.

Keeping them separate means the remote class stays a pure RPC transport surface, while the local class stays a pure consumer convenience layer.

If we merged them, we would either:

- leak transport concerns like serialized results into callers, or
- push caller-side concerns like `DurableObjectError` wrapping into the remote object design.

So the split is not strictly required, but it keeps the boundaries clean and avoids recreating another generic wrapper pattern.

---

## Connector helper

### Sketch

```ts
export async function getSongQueue(name = "song-queue"): Promise<SongQueueClient> {
	const env = getEnv();
	const stub = env.SONG_QUEUE_DO.getByName(name);

	// Transitional bootstrap can live here if needed.
	// This is a better place than per-method stub interception.
	// await ensureAgentInitialized(stub, name);

	const handle = await stub.connectRpc(name);
	return new SongQueueClient(handle);
}
```

### Why this helper exists

It gives callers a narrow API and centralizes connection/bootstrap behavior.

This is a better fit than a global generic `getStub()` wrapper because:

- connection behavior can differ by DO domain
- bootstrap behavior can differ by DO domain
- typing is more explicit
- call sites become more readable

---

## Route examples

### `/api/queue`

```ts
api.get("/queue", async (c) => {
	const queryResult = QueueQuerySchema.safeParse({
		limit: c.req.query("limit"),
	});

	if (!queryResult.success) {
		return c.json({ error: "Invalid query parameters", details: queryResult.error.issues }, 400);
	}

	using queue = await getSongQueue();
	const result = await queue.getSongQueue(queryResult.data.limit);

	if (result.status === "error") {
		logger.error("Failed to get queue", { error: result.error.message });
		return c.json({ error: "Failed to fetch queue" }, 500);
	}

	return c.json(result.value);
});
```

### `/api/now-playing`

```ts
api.get("/now-playing", async (c) => {
	using queue = await getSongQueue();
	const result = await queue.getCurrentlyPlaying();

	if (result.status === "error") {
		logger.error("Failed to get now playing", { error: result.error.message });
		return c.json({ error: "Failed to fetch now playing" }, 500);
	}

	return c.json(result.value);
});
```

### Benefits at call sites

- no `Result.deserialize()`
- no transport details
- no generic `wrapStub()` behavior
- no direct bootstrap logic in routes
- same ergonomic result handling as today

---

## Agent bootstrap strategy

This design improves the API shape, but Agent/bootstrap still needs an explicit strategy.

### What should not happen

Bootstrap should **not** run implicitly on every business method call.

That is one of the core problems in the current `wrapStub()` pattern.

### Better places for bootstrap

#### Best long-term

Provision singleton Agents explicitly via a control-plane path, startup path, or administrative bootstrap process.

Then `getSongQueue()` can assume the Agent has already been initialized.

#### Transitional option

Place lazy bootstrap in one explicit place:

- inside `getSongQueue()`
- or inside `_SongQueueDO.connect(name)`

That keeps bootstrap off the per-method data path.

### Principle

Bootstrap should be tied to **connection/setup**, not to business RPC execution.

---

## Why this is better than `wrapStub()`

### 1. Eliminates the generic per-method Proxy from hot paths

The runtime is no longer hidden behind a wrapper intercepting every method on every stub.

### 2. Separates control plane from data plane

- `connect()` and connector helpers handle setup
- handle methods and internal methods handle data-plane work

This better matches Cloudflare's control-plane/data-plane guidance.

### 3. Keeps serialization as an internal transport concern

`better-result` stays in the project, but callers never see serialization details.

### 4. Uses native Cloudflare RPC concepts

This design leans on:

- `DurableObjectStub`
- `RpcTarget`
- `using` / disposal semantics

rather than re-creating a remote object model via `Proxy`.

### 5. Gives each Durable Object a domain-specific client API

A `SongQueueClient` is clearer than a generic wrapped DO stub because the domain contract is explicit.

---

## Recommended file layout

### `apps/api/src/lib/rpc-result.ts`

Transport helpers only:

- `toRpcResult`
- `fromRpcResult`
- `callRpcResult`
- `rpcInfraError`

### `apps/api/src/durable-objects/song-queue-do.ts`

Contains:

- `_SongQueueDO`
- `SongQueueRpcHandle`
- internal business methods such as `getSongQueueInternal()`

### `apps/api/src/lib/song-queue-client.ts`

Contains:

- `SongQueueClient`
- `getSongQueue()`

### `apps/api/src/lib/durable-objects.ts`

Should become much smaller and focus on:

- env lookup
- singleton name constants
- possibly generic namespace helpers

It should no longer be responsible for the full RPC transport abstraction.

---

## Migration plan

### Phase 1: pilot on `SongQueueDO`

Migrate these callers first:

- `/api/queue`
- `/api/now-playing`
- `/api/song-requests/history`

### Phase 2: remove `getStub("SONG_QUEUE_DO")` from hot paths

Once callers use `getSongQueue()`, the current `wrapStub()` logic is no longer in the critical path for `SongQueueDO`.

### Phase 3: apply the same pattern to other Agent-backed DOs

Likely candidates:

- `StreamLifecycleDO`
- `SpotifyTokenDO`
- `TwitchTokenDO`
- `EventBusDO`

### Phase 4: simplify `apps/api/src/lib/durable-objects.ts`

At that point, `durable-objects.ts` should shrink into a narrow lookup/helper module.

---

## Tradeoffs

### Pros

- explicit control-plane/data-plane boundary
- no generic stub proxy on hot business paths
- better alignment with Cloudflare RPC and `RpcTarget`
- callers keep current ergonomic `Result` handling
- serialization remains internal
- domain-specific clients improve readability and maintainability

### Cons

- requires a medium-sized refactor
- introduces more explicit types/files per DO
- some call sites must switch from `getStub()` to `connectX()` helpers
- bootstrap still needs a real strategy during migration

---

## Recommendation

Use this design first for `SongQueueDO`.

Implementation guidance:

- add `connect(name)` to `SongQueueDO`
- add `SongQueueRpcHandle extends RpcTarget`
- move current public business methods into internal methods
- add `SongQueueClient` and `getSongQueue()`
- keep `better-result`
- keep serialization/deserialization hidden inside transport/client internals
- move bootstrap to the connection path, not the per-method path

---

## Summary

This design replaces a generic stub-wrapping proxy with an explicit native RPC pattern:

1. connect to a Durable Object
2. receive a typed `RpcTarget` handle
3. keep business logic internal to the DO
4. serialize `Result` only at the transport boundary using:
   ```ts
   this.queue.fn(args).then(toRpcResult);
   ```
5. immediately rehydrate the result inside a local client facade
6. let callers use a clean API:
   ```ts
   using queue = await getSongQueue();
   const result = await queue.getSongQueue(limit);
   ```

This is a better fit for Cloudflare Durable Objects, `RpcTarget`, and the control-plane/data-plane separation than the current `wrapStub()` approach.
