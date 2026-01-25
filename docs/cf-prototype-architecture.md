# CF-TWITCH: Architecture & PRD

> Cloudflare Workers application for Twitch/Spotify integration

## System Overview

```
+------------------+     +-------------------+     +------------------+
|                  |     |                   |     |                  |
|  Twitch EventSub +---->+  CF Worker (Hono) +---->+  CF Queue        |
|  (Webhooks)      |     |  /cf-twitch/*     |     |  cf-twitch-queue |
|                  |     |                   |     |                  |
+------------------+     +-------------------+     +--------+---------+
                                                           |
                         +------------------+              |
                         |                  |              |
                         |  Twitch API      |              |
                         |  (RPC Service)   |<----+        |
                         |                  |     |        |
                         +------------------+     |        v
                                                  |  +-----+-----------+
+------------------+     +------------------+     |  |                 |
|                  |     |                  |     +--+  CF Workflows   |
|  Spotify API     |<----+  Durable Objects |<-------+                 |
|                  |     |  (SQLite state)  |        | - KeyboardRaffle|
|                  |     |                  |        | - RequestSong   |
+------------------+     +------------------+        +-----------------+
```

---

## Features

### 1. Keyboard Raffle

Viewers redeem channel points for a random number lottery.

```
USER REDEEMS POINTS
       |
       v
+------+------+     +-------+     +----------+     +--------+
| Twitch      | --> | Queue | --> | Workflow | --> | DO     |
| EventSub    |     |       |     |          |     | SQLite |
+-------------+     +-------+     +----+-----+     +--------+
                                       |
                                       v
                              +--------+--------+
                              | Twitch Chat     |
                              | "won/lost" msg  |
                              +-----------------+
```

**Flow:**

1. Viewer redeems "Keyboard Raffle" reward
2. EventSub webhook -> Queue message
3. Workflow rolls two numbers (winning, user's)
4. Persist to `KeyboardRaffleDO` (SQLite)
5. Update redemption status (FULFILLED/CANCELED)
6. Send result to Twitch chat

### 2. Song Request

Viewers submit Spotify URLs via channel points.

```
USER SUBMITS SPOTIFY URL
       |
       v
+------+------+     +-------+     +----------+     +----------+
| Twitch      | --> | Queue | --> | Workflow | --> | DO       |
| EventSub    |     |       |     |          |     | + Spotify|
+-------------+     +-------+     +----+-----+     +----+-----+
                                       |                |
                                       v                v
                              +--------+--------+  +----+------+
                              | Twitch Chat     |  | Spotify   |
                              | "queued X" msg  |  | Queue API |
                              +-----------------+  +-----------+
```

**Flow:**

1. Viewer redeems "Song Request" with Spotify URL
2. EventSub webhook -> Queue message
3. Workflow parses track ID from URL
4. `SongQueueDO` fetches track metadata + adds to playback queue
5. Persist to SQLite (history + queue tables)
6. Update redemption status
7. Send confirmation to Twitch chat

---

## Cloudflare Primitives

| Type               | Binding              | Class                    | Purpose                     |
| ------------------ | -------------------- | ------------------------ | --------------------------- |
| **Durable Object** | `KEYBOARD_RAFFLE_DO` | `KeyboardRaffleDO`       | Raffle roll persistence     |
| **Durable Object** | `SONG_QUEUE_DO`      | `SongQueueDO`            | Song queue + Spotify tokens |
| **Workflow**       | `KEYBOARD_RAFFLE_WF` | `KeyboardRaffleWorkflow` | Raffle orchestration        |
| **Workflow**       | `REQUEST_SONG_WF`    | `RequestSongWorkflow`    | Song request orchestration  |
| **Queue**          | `QUEUE`              | `cf-twitch-queue`        | Async message dispatch      |
| **Service**        | `TWITCH`             | `TwitchClientEntrypoint` | Self-ref RPC for Twitch API |

---

## Entry Points

### HTTP Handler (`src/server.ts`)

```typescript
const app = new Hono<{ Bindings: Env }>().basePath("/cf-twitch");

// Debug endpoint
app.get("/", async (c) => {
	const songQueue = SongQueueDO.get(c.env);
	return c.json(await songQueue.getCurrentlyPlaying());
});

// Twitch EventSub webhook
app.post("/webhooks/twitch", twitchWebhookValidation(), async (c) => {
	const headers = c.get("twitchHeaders");
	const rawBody = c.get("twitchRawBody");

	// Challenge response for subscription verification
	if (headers.messageType === "webhook_callback_verification") {
		const payload = TwitchVerification.fromJson(rawBody);
		return c.text(payload.value.challenge, 200);
	}

	// Notification handling
	if (headers.messageType === "notification") {
		const result = await handleTwitchNotification(rawBody, c.env.QUEUE);
		// ... error handling
	}
});

export default {
	fetch: app.fetch,
	queue: Queue.handle,
} satisfies ExportedHandler<Env, QueueMessage>;
```

### Queue Consumer (`src/lib/queue/consumer.ts`)

```typescript
export const Queue = {
	handle: (batch, env, ctx) => {
		for (const message of batch.messages) {
			switch (message.body._tag) {
				case "KeyboardRaffleRedemption":
					ctx.waitUntil(handleKeyboardRaffleMessage(env, message));
					return;
				case "SongRequestRedemption":
					ctx.waitUntil(handleSongRequestMessage(env, message));
					return;
				default:
					message.body satisfies never; // exhaustiveness
			}
		}
	},
} as const satisfies QueueHandler;

async function handleKeyboardRaffleMessage(env: Env, msg: Message<KeyboardRaffleRedemption>) {
	await env.KEYBOARD_RAFFLE_WF.create({ params: msg.body });
	msg.ack();
}
```

---

## Durable Objects

### KeyboardRaffleDO

```
+---------------------------+
| KeyboardRaffleDO          |
+---------------------------+
| - db: DrizzleSqliteDO     |
+---------------------------+
| + recordRoll(Roll): id    |
| + deleteRollById(id): bool|
+---------------------------+
        |
        v
+---------------------------+
| rolls (SQLite)            |
+---------------------------+
| id: text PK (roll_*)      |
| user_display_name: text   |
| roll: integer             |
| winning_number: integer   |
| status: "won" | "lost"    |
| rolled_at: text (ISO8601) |
+---------------------------+
```

```typescript
// src/durable-objects/keyboard-raffle/keyboard-raffle-do.ts
export class KeyboardRaffleDO extends DurableObject {
	private readonly db: DrizzleSqliteDODatabase;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage);
		void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
	}

	static get(env: Env) {
		return env.KEYBOARD_RAFFLE_DO.getByName("keyboard-raffle");
	}

	async recordRoll(roll: Roll): Promise<string> {
		const [inserted] = await this.db
			.insert(rolls)
			.values({
				userDisplayName: roll.userDisplayName,
				roll: roll.roll,
				winningNumber: roll.winningNumber,
				status: roll.status,
				rolledAt: new Date(),
			})
			.returning({ id: rolls.id });
		return inserted.id;
	}

	async deleteRollById(id: string): Promise<boolean> {
		await this.db.delete(rolls).where(eq(rolls.id, id));
		return true;
	}
}
```

### SongQueueDO

```
+------------------------------------+
| SongQueueDO                        |
+------------------------------------+
| - db: DrizzleSqliteDO              |
| - spotify: SpotifyApi | null       |
+------------------------------------+
| + getCurrentlyPlaying(): Playback  |
| + addSongToQueue(id, user): Result |
| + revokeSongRequest(id): void      |
+------------------------------------+
        |
        v
+---------------------------+     +---------------------------+
| token_set (SQLite)        |     | song_request_history      |
+---------------------------+     +---------------------------+
| id: 1 (singleton)         |     | id: text PK (song_*)      |
| access_token: text        |     | album_cover_href: text    |
| token_type: text          |     | album_name: text          |
| expires_in: integer       |     | artists: json             |
| refresh_token: text       |     | song_name: text           |
| expires: integer          |     | requester_display_name    |
+---------------------------+     | requested_at: text        |
                                  +---------------------------+
        |
        v
+---------------------------+
| song_queue (SQLite)       |
+---------------------------+
| id: text PK (item_*)      |
| type: "requested"|"synced"|
| album_*, artists, song_*  |
| requester_display_name?   |
| requested_at: text        |
+---------------------------+
```

```typescript
// src/durable-objects/song-queue/spotify-song-queue-do.ts
export class SongQueueDO extends DurableObject {
  private spotify: SpotifyApi | null = null;

  private getSpotify(): SpotifyApi {
    if (this.spotify !== null) return this.spotify;

    // Load tokens from DB or fallback to env
    const storedTokens = this.db.select().from(tokenSet).where(eq(tokenSet.id, 1)).all();
    const accessToken = storedTokens[0] ?? { /* fallback to env vars */ };

    this.spotify = getSpotifyClient({
      clientId: this.env.SPOTIFY_CLIENT_ID,
      clientSecret: this.env.SPOTIFY_CLIENT_SECRET,
      accessToken,
      // Persist refreshed tokens
      onRefresh: async (refreshed) => {
        this.db.insert(tokenSet).values({...})
          .onConflictDoUpdate({ target: tokenSet.id, set: {...} })
          .run();
      },
    });
    return this.spotify;
  }

  async addSongToQueue(songId: string, requesterDisplayName: string) {
    const song = await this.getSpotify().tracks.get(songId);

    return this.db.transaction(async (txn) => {
      // 1. Insert to history
      const [historyId] = await txn.insert(songRequestHistory).values({...}).returning();

      // 2. Add to Spotify playback queue
      await this.getSpotify().player.addItemToPlaybackQueue(`spotify:track:${songId}`);

      // 3. Insert to local queue
      const [queueId] = await txn.insert(songQueue).values({...}).returning();

      return { songRequestId: historyId.id, songQueueItemId: queueId.id };
    });
  }
}
```

---

## Workflows

### Rollback Pattern

Both workflows use `cf-workflow-rollback` for compensating transactions:

```typescript
import { withRollback } from "cf-workflow-rollback";

const step = withRollback(workflowStep);

// Step with rollback capability
await step.doWithRollback("persist result", {
  run: async () => {
    const storage = KeyboardRaffleDO.get(this.env);
    return storage.recordRoll({...}); // returns id
  },
  undo: async (error, id) => {
    const storage = KeyboardRaffleDO.get(this.env);
    await storage.deleteRollById(id);
  },
}, retryPolicy);

// On error path:
await step.rollbackAll(error);
await step.do("refund points", retryPolicy, async () => {
  await this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "CANCELED");
});
```

### KeyboardRaffleWorkflow

```
START ──► roll winning# ──► roll user# ──► persist(DO) ──► fulfill ──► chat ──► END
  │                                            │
  │          ERROR at any point                │
  │                ↓                           │
  └───────► rollbackAll() ──► refund ──► chat fail ──► THROW
```

```typescript
// src/workflows/keyboard-raffle-workflow.ts
export class KeyboardRaffleWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, workflowStep: WorkflowStep) {
		const { requesterDisplayName, eventId, rewardId } = event.payload;
		const step = withRollback(workflowStep);

		try {
			const winningNumber = await step.do("roll winning number", retryPolicy, () =>
				generateNumber(),
			);

			const rolledNumber = await step.do("roll users number", retryPolicy, () => generateNumber());

			const status = rolledNumber === winningNumber ? "won" : "lost";

			await step.doWithRollback(
				"persist result to storage",
				{
					run: async () => {
						const storage = KeyboardRaffleDO.get(this.env);
						return storage.recordRoll({
							userDisplayName: requesterDisplayName,
							roll: rolledNumber,
							status,
							winningNumber,
						});
					},
					undo: async (_, id) => {
						const storage = KeyboardRaffleDO.get(this.env);
						await storage.deleteRollById(id);
					},
				},
				retryPolicy,
			);

			await step.do("update redemption status", retryPolicy, async () => {
				await this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "FULFILLED");
			});

			await step.do("send chat message", retryPolicy, async () => {
				await this.env.TWITCH.sendChatMessage(
					status === "won"
						? `@${requesterDisplayName} won! Winning: ${winningNumber}, rolled: ${rolledNumber}`
						: `@${requesterDisplayName} lost. Winning: ${winningNumber}, rolled: ${rolledNumber}`,
				);
			});
		} catch (error) {
			await step.rollbackAll(error);
			await step.do("refund points", retryPolicy, () =>
				this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "CANCELED"),
			);
			await step.do("send failure message", retryPolicy, () =>
				this.env.TWITCH.sendChatMessage(
					`@${requesterDisplayName} error occurred. Points refunded.`,
				),
			);
			throw error;
		}
	}
}
```

### RequestSongWorkflow

```
START ──► parse URL ──► addToQueue(DO+Spotify) ──► fulfill ──► chat ──► END
  │                            │
  │     ERROR at any point     │
  │            ↓               │
  └────► rollbackAll() ──► refund ──► chat fail ──► THROW
```

```typescript
// src/workflows/request-song-workflow.ts
const songIdRegex = /\/track\/([a-zA-Z0-9]*)/;

function getSongIdFromUrl(url: string): string {
	const result = songIdRegex.exec(url);
	if (!result) throw new InvalidSongUrl(url);
	return result[1];
}

export class RequestSongWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, workflowStep: WorkflowStep) {
		const { requesterDisplayName, spotifyUrl, eventId, rewardId } = event.payload;
		const step = withRollback(workflowStep);
		const songQueue = SongQueueDO.get(this.env);

		try {
			const songId = await step.do("parse song id", retryPolicy, () =>
				getSongIdFromUrl(spotifyUrl),
			);

			const { song } = await step.doWithRollback("add song to queue", {
				run: () => songQueue.addSongToQueue(songId, requesterDisplayName),
				undo: (_, result) => songQueue.revokeSongRequest(result.id),
			});

			await step.do("update redemption status", retryPolicy, () =>
				this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "FULFILLED"),
			);

			await step.do("send chat message", retryPolicy, () =>
				this.env.TWITCH.sendChatMessage(
					`@${requesterDisplayName} queued "${song.name}" by ${song.artists.map((a) => a.name).join(", ")}`,
				),
			);
		} catch (error) {
			await step.rollbackAll(error);
			await step.do("refund points", retryPolicy, () =>
				this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "CANCELED"),
			);
			await step.do("send failure message", retryPolicy, () =>
				this.env.TWITCH.sendChatMessage(`@${requesterDisplayName} invalid URL. Points refunded.`),
			);
			throw error;
		}
	}
}
```

---

## FP Primitives (`src/lib/`)

### Result ADT

```
Result<A, E> = Ok<A> | Err<E>

            +--------+
            | Result |
            +---+----+
                |
       +--------+--------+
       |                 |
   +---+---+         +---+---+
   |  Ok   |         |  Err  |
   | value |         | error |
   +-------+         +-------+

AsyncResult<A, E> = Promise<Result<A, E>> wrapper
```

```typescript
// Core types
export type Result<A, E> = Ok<A, E> | Err<E, A>;

export class Ok<A, E = never> {
  readonly _tag = "Ok" as const;
  constructor(readonly value: A) {}
  isOk(): this is Ok<A, E> { return true; }
  isErr(): this is Err<E, A> { return false; }
  map<U>(fn: (v: A) => U): Result<U, E> { return ok(fn(this.value)); }
  mapErr<F>(_: (e: E) => F): Result<A, F> { return this as any; }
  andThen<R>(fn: (v: A) => R): R { return fn(this.value); }
  unwrap(): A { return this.value; }
  match<U>(h: { ok: (v: A) => U; err: (e: E) => U }): U { return h.ok(this.value); }
}

export class Err<E, A = never> {
  readonly _tag = "Err" as const;
  constructor(readonly error: E) {}
  isOk(): this is Ok<A, E> { return false; }
  isErr(): this is Err<E, A> { return true; }
  map<U>(_: (v: A) => U): Result<U, E> { return this as any; }
  mapErr<F>(fn: (e: E) => F): Result<A, F> { return err(fn(this.error)); }
  unwrap(): A { throw this.error; }
  match<U>(h: { ok: (v: A) => U; err: (e: E) => U }): U { return h.err(this.error); }
}

// Factory namespace
export const Result = {
  ok: <A>(value: A) => new Ok(value),
  err: <E>(error: E) => new Err(error),
  tryPromise: <T, E>({ try: fn, catch: handler }: {
    try: () => Promise<T>;
    catch: (cause: unknown) => E;
  }): AsyncResult<T, E> => { ... },
} as const;
```

**Usage:**

```typescript
// Wrap async operations
const result = await Result.tryPromise({
	try: () => fetch(url).then((r) => r.json()),
	catch: (cause) => new FetchError({ url, cause }),
});

// Chain transformations
result
	.map((data) => data.items)
	.andThen((items) => (items.length > 0 ? Result.ok(items[0]) : Result.err(new EmptyError())))
	.match({
		ok: (item) => console.log(item),
		err: (e) => console.error(e._tag),
	});
```

### TaggedError Factory

```typescript
// Creates error class with _tag discriminator
export function TaggedError<Tag extends string>(tag: Tag) {
	return class extends Error {
		readonly _tag = tag;
		constructor(props?: { cause?: unknown; message?: string; [k: string]: unknown }) {
			super(props?.message ?? tag, { cause: props?.cause });
			Object.assign(this, props);
		}
		toJSON() {
			return { _tag: tag, message: this.message, ...this };
		}
	};
}

// Usage
class JsonParseError extends TaggedError("JsonParseError")<{
	schema: string;
	cause: unknown;
}> {}

class SongNotFound extends TaggedError("SongNotFound")<{
	songId: string;
	cause: unknown;
}> {
	override get message() {
		return `Could not find song with id '${this.songId}'`;
	}
}

// Pattern matching
switch (error._tag) {
	case "JsonParseError":
		return c.json({ error: "Invalid JSON" }, 400);
	case "SongNotFound":
		return c.json({ error: error.message }, 404);
}
```

### Redacted (Secret Hiding)

```typescript
// Prevents secrets from appearing in logs/JSON
const registry = new WeakMap<Redacted<any>, any>();

export const Redacted = {
	make<A>(value: A): Redacted<A> {
		const redacted = Object.create({
			toString: () => "<redacted>",
			toJSON: () => "<redacted>",
			[Symbol.for("nodejs.util.inspect.custom")]: () => "<redacted>",
		});
		registry.set(redacted, value);
		return redacted;
	},
	value<A>(self: Redacted<A>): A {
		return registry.get(self);
	},
};

// Usage
const client = getTwitchClient({
	twitchAccessToken: Redacted.make(env.TWITCH_ACCESS_TOKEN),
	twitchClientSecret: Redacted.make(env.TWITCH_CLIENT_SECRET),
});
console.log(client.config); // { twitchAccessToken: "<redacted>", ... }
```

---

## Twitch Integration

### Webhook Validation Middleware

```typescript
// src/lib/twitch/middleware.ts
export const twitchWebhookValidation = (): MiddlewareHandler<TwitchWebhookEnv> => {
	return async (c, next) => {
		// 1. Parse headers via Zod
		const headersResult = TwitchWebhookHeaders.parse(c.req.raw.headers);
		if (!headersResult.success) return c.json({ error: "Invalid headers" }, 400);

		const headers = headersResult.data;
		const rawBody = await c.req.text();

		// 2. Compute HMAC-SHA256
		const message = `${headers.messageId}${headers.messageTimestamp}${rawBody}`;
		const hmac =
			"sha256=" +
			Crypto.createHmac("sha256", c.env.TWITCH_WEBHOOK_SECRET).update(message).digest("hex");

		// 3. Timing-safe compare
		const isValid = Crypto.timingSafeEqual(
			Buffer.from(hmac),
			Buffer.from(headers.messageSignature),
		);
		if (!isValid) return c.json({ error: "Invalid signature" }, 403);

		// 4. Store for handler
		c.set("twitchHeaders", headers);
		c.set("twitchRawBody", rawBody);
		await next();
	};
};
```

### EventSub Event Types

```typescript
// Discriminated union for event types
export type EventSubEvent = ChannelChatMessageEvent | ChannelPointsRedemptionEvent;

export type ChannelPointsRedemptionEvent = {
	_tag: "channel.channel_points_custom_reward_redemption.add";
	id: string;
	user_id: string;
	user_name: string;
	user_input: string;
	status: "unfulfilled" | "fulfilled" | "canceled";
	reward: {
		id: string;
		title: string;
		cost: number;
		prompt: string;
	};
	redeemed_at: Date;
};
```

### RPC Service

```typescript
// src/lib/twitch/twitch-rpc-client.ts
export class TwitchClientEntrypoint extends WorkerEntrypoint<Env> {
	async sendChatMessage(message: string): Promise<void> {
		const client = this.getClient();
		await client.chat.sendChatMessage(this.env.TWITCH_BROADCASTER_ID, message);
	}

	async updateRedemptionStatus(
		rewardId: string,
		eventIds: ReadonlyArray<string>,
		status: "FULFILLED" | "CANCELED",
	): Promise<void> {
		const client = this.getClient();
		await client.channelPoints.updateRedemptionStatusByIds(
			this.env.TWITCH_BROADCASTER_ID,
			rewardId,
			[...eventIds],
			status,
		);
	}
}
```

---

## Queue Messages

```typescript
// Discriminated union
export type QueueMessage = KeyboardRaffleRedemption | SongRequestRedemption;

export type KeyboardRaffleRedemption = Readonly<{
	_tag: "KeyboardRaffleRedemption";
	requesterDisplayName: string;
	eventId: string;
	rewardId: string;
}>;

export type SongRequestRedemption = Readonly<{
	_tag: "SongRequestRedemption";
	requesterDisplayName: string;
	spotifyUrl: string;
	eventId: string;
	rewardId: string;
}>;

// Hardcoded reward IDs
export const RewardRedemption = {
	SongRequest: "c2063c79-a24c-4b17-94f7-c871f2876708",
	KeyboardRaffle: "29afa291-244a-47a8-8be8-ded13995e83d",
	isSupported: (id: string) =>
		id === RewardRedemption.SongRequest || id === RewardRedemption.KeyboardRaffle,
} as const;

// Factory from Twitch event
export const QueueMessage = {
	fromChannelPointsRedemptionEvent: (event: ChannelPointsRedemptionEvent): QueueMessage => {
		switch (event.reward.id) {
			case RewardRedemption.KeyboardRaffle:
				return {
					_tag: "KeyboardRaffleRedemption",
					requesterDisplayName: event.user_name,
					eventId: event.id,
					rewardId: event.reward.id,
				};
			case RewardRedemption.SongRequest:
				return {
					_tag: "SongRequestRedemption",
					requesterDisplayName: event.user_name,
					spotifyUrl: event.user_input,
					eventId: event.id,
					rewardId: event.reward.id,
				};
			default:
				throw new Error("Unsupported reward");
		}
	},
};
```

---

## Complete Data Flow

```
                                 TWITCH EVENTSUB
                                       |
                                       v
+------------------------------------------------------------------------------+
|                              CF WORKER (Hono)                                |
|                                                                              |
|  POST /cf-twitch/webhooks/twitch                                             |
|    |                                                                         |
|    +---> twitchWebhookValidation()  [HMAC-SHA256 verify]                     |
|    |                                                                         |
|    +---> handleTwitchNotification()                                          |
|           |                                                                  |
|           +---> EventSubNotification.fromJson()  [Zod parse]                 |
|           |                                                                  |
|           +---> RewardRedemption.isSupported()  [filter known rewards]       |
|           |                                                                  |
|           +---> QueueMessage.fromChannelPointsRedemptionEvent()              |
|           |                                                                  |
|           +---> queue.send(message)                                          |
|                                                                              |
+------------------------------------------------------------------------------+
                                       |
                                       v
+------------------------------------------------------------------------------+
|                              CF QUEUE                                        |
|                                                                              |
|  Queue.handle(batch)                                                         |
|    |                                                                         |
|    +---> switch (message.body._tag)                                          |
|           |                                                                  |
|           +---> "KeyboardRaffleRedemption"                                   |
|           |       +---> env.KEYBOARD_RAFFLE_WF.create({ params })            |
|           |       +---> message.ack()                                        |
|           |                                                                  |
|           +---> "SongRequestRedemption"                                      |
|                   +---> env.REQUEST_SONG_WF.create({ params })               |
|                   +---> message.ack()                                        |
|                                                                              |
+------------------------------------------------------------------------------+
                                       |
              +------------------------+------------------------+
              |                                                 |
              v                                                 v
+-----------------------------+               +-----------------------------+
|   KEYBOARD RAFFLE WORKFLOW  |               |    REQUEST SONG WORKFLOW    |
+-----------------------------+               +-----------------------------+
| 1. roll winning number      |               | 1. parse song ID from URL   |
| 2. roll user number         |               | 2. DO.addSongToQueue()      |
| 3. DO.recordRoll()          |               |    - Spotify.tracks.get()   |
| 4. TWITCH.updateRedemption  |               |    - Spotify.queue.add()    |
| 5. TWITCH.sendChatMessage   |               |    - SQLite persist         |
|                             |               | 3. TWITCH.updateRedemption  |
| ON ERROR:                   |               | 4. TWITCH.sendChatMessage   |
|   rollbackAll()             |               |                             |
|   refund points             |               | ON ERROR:                   |
|   send failure message      |               |   rollbackAll()             |
+-----------------------------+               |   refund points             |
              |                               |   send failure message      |
              v                               +-----------------------------+
+-----------------------------+                              |
|    KEYBOARD RAFFLE DO       |                              v
+-----------------------------+               +-----------------------------+
| SQLite: rolls table         |               |       SONG QUEUE DO         |
| - id, user, roll, winning#  |               +-----------------------------+
| - status (won/lost)         |               | SQLite:                     |
| - rolled_at                 |               |   token_set (OAuth)         |
+-----------------------------+               |   song_request_history      |
                                              |   song_queue                |
                                              |                             |
                                              | Spotify API:                |
                                              |   tracks.get()              |
                                              |   player.addToQueue()       |
                                              +-----------------------------+
```

---

## Tooling

| Tool        | Command               | Purpose                 |
| ----------- | --------------------- | ----------------------- |
| wrangler    | `bun run dev`         | Local development       |
| wrangler    | `bun run deploy`      | Deploy to CF            |
| oxlint      | `bun run lint`        | Type-aware linting      |
| oxfmt       | `bun run format`      | Code formatting         |
| tsgo        | `bun run typecheck`   | Native TS type checking |
| drizzle-kit | `bun run db:generate` | Generate migrations     |

---

## Environment Variables

```typescript
// wrangler.jsonc vars (public)
TWITCH_CLIENT_ID: "YOUR_TWITCH_CLIENT_ID";
TWITCH_BROADCASTER_ID: "209286766";
TWITCH_BROADCASTER_NAME: "dmmulroy";

// Secrets (via wrangler secret)
TWITCH_CLIENT_SECRET;
TWITCH_ACCESS_TOKEN;
TWITCH_REFRESH_TOKEN;
TWITCH_WEBHOOK_SECRET;
SPOTIFY_CLIENT_ID;
SPOTIFY_CLIENT_SECRET;
SPOTIFY_ACCESS_TOKEN;
SPOTIFY_REFRESH_TOKEN;
```

---

## Key Design Decisions

1. **Result-based error handling** - No throwing for expected failures; use `Result<T, E>` ADT
2. **Tagged errors** - All errors have `_tag` for exhaustive pattern matching
3. **Workflow rollback** - Compensating transactions via `cf-workflow-rollback`
4. **DO singleton pattern** - Single instance per DO type via `getByName()`
5. **Token persistence** - Spotify OAuth tokens stored in DO SQLite, auto-refreshed
6. **Self-referential RPC** - Twitch API calls via `WorkerEntrypoint` for isolation
7. **ULID-prefixed IDs** - All DB records use `prefix_ULID` format for debuggability
8. **Queue-based async** - Webhooks immediately ack; processing via Queue -> Workflow
9. **Strict TypeScript** - `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any`/`!`/`as`
