# CF-TWITCH: Product Requirements Document

**Version:** 1.1  
**Date:** 2026-01-12  
**Status:** Draft

---

## 1. Overview

Rebuild Twitch integration service on Cloudflare Workers. Serverless, edge-native architecture replacing the Effect-TS/Fly.io production system.

### 1.1 Goals

- Zero infrastructure management (no Fly.io VMs)
- Sub-100ms webhook response times
- Automatic scaling during stream spikes
- Durable state with SQLite-backed Durable Objects
- Compensating transactions via Workflows

### 1.2 Non-Goals

- Migration tooling from Effect system (clean slate)
- Nix Timer feature (deferred)
- EventSub WebSocket (webhooks only)
- Stream Overlays (deferred to v2)

---

## 2. Features (v1 Scope)

| Feature            | Trigger        | Description                         |
| ------------------ | -------------- | ----------------------------------- |
| Song Request       | Channel Points | Queue Spotify track via URL         |
| !song              | Chat command   | Show currently playing in chat      |
| !queue             | Chat command   | Show next 4 tracks in chat          |
| Keyboard Raffle    | Channel Points | 1/10000 lottery                     |
| Stream Overlays    | HTTP           | Now playing + queue widgets for OBS |
| Request History    | API            | Track all song requests over time   |
| Top Tracks         | API            | Most requested songs (global)       |
| Top Tracks by User | API            | Most requested songs per user       |
| Top Requesters     | API            | Users with most requests            |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        TWITCH EVENTSUB                          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  cf-twitch-api Worker                                           │
│  ├─ POST /webhooks/twitch (HMAC + timestamp validation)         │
│  ├─ GET /api/now-playing, /api/queue                            │
│  ├─ GET /api/stats/* (cached, etag)                             │
│  ├─ GET /api/history                                            │
│  └─ GET /oauth/spotify/*, /oauth/twitch/* (OAuth flows)         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  CF Queue (cf-twitch-queue)                                     │
│  Messages: SongRequest | ChatCommand | KeyboardRaffle           │
└─────────────────────────────────────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ SongRequestWF    │  │ ChatCommandWF    │  │ KeyboardRaffleWF │
│ - parse URL      │  │ - get queue/now  │  │ - roll numbers   │
│ - get track      │  │ - format msg     │  │ - calc distance  │
│ - add to Spotify │  │ - send chat      │  │ - update leader  │
│ - persist + sync │  └──────────────────┘  │ - fulfill/refund │
│ - fulfill/refund │                        │ - send chat      │
│ - write history  │                        │ - analytics      │
│ - analytics      │                        └──────────────────┘
└──────────────────┘
          │                                           │
          ▼                                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DURABLE OBJECTS                            │
│                                                                 │
│  SpotifyTokenDO (singleton)     TwitchTokenDO (singleton)       │
│  └─ getValidToken()             └─ getValidToken()              │
│  └─ setTokens()                 └─ setTokens()                  │
│                                                                 │
│  SongQueueDO (singleton)        KeyboardRaffleDO (singleton)    │
│  └─ pending_requests            └─ rolls                        │
│  └─ spotify_queue_snapshot      └─ raffle_leaderboard           │
│  └─ request_history             └─ recordRoll()                 │
│  └─ persistRequest() + sync     └─ getLeaderboard()             │
│  └─ getCurrentlyPlaying()       └─ getUserStats()               │
│  └─ getQueue()                                                  │
│  └─ getTopTracks()                                              │
└─────────────────────────────────────────────────────────────────┘
          │                                           │
          ▼                                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Services (Plain Classes)                                       │
│                                                                 │
│  SpotifyService                 TwitchService                   │
│  └─ constructor(env: Env)       └─ constructor(env: Env)        │
│  └─ getTrack(id)                └─ sendChatMessage(msg)         │
│  └─ addToQueue(id)              └─ updateRedemptionStatus()     │
│  └─ getCurrentlyPlaying()       └─ getStreamInfo()              │
│  └─ getQueue()                                                  │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Analytics Engine (cf_twitch_metrics)                           │
│  └─ song_request events (requester, track, latency, status)     │
│  └─ raffle_roll events (user, roll, winning, distance, status)  │
│  └─ error events (script, outcome)                              │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  cf-twitch-tail Worker                                          │
│  └─ Error tracking + structured logging                         │
│  └─ Analytics Engine writes for error trends                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Technology Stack

| Layer             | Technology                                                 |
| ----------------- | ---------------------------------------------------------- |
| Runtime           | Cloudflare Workers                                         |
| HTTP Framework    | Hono                                                       |
| State             | Durable Objects (SQLite)                                   |
| Orchestration     | Cloudflare Workflows                                       |
| Async Processing  | Cloudflare Queues                                          |
| Error Handling    | better-result (errors extend TaggedError)                  |
| Workflow Rollback | cf-workflow-rollback                                       |
| ORM               | Drizzle + drizzle-orm/durable-sqlite (official DO adapter) |
| Schema Validation | Zod v4                                                     |
| HTTP Framework    | Hono (all API routes, webhooks, OAuth)                     |

---

## 4.1 Critical Patterns

### DO Communication

- **DO-to-DO**: Use RPC methods directly via `getStub('DO_NAME').myMethod()`, NEVER fetch
- **DO to external APIs**: Instantiate services directly: `new TwitchService(this.env)`
- **Services use getStub()**: Call token DOs via `getStub('SPOTIFY_TOKEN_DO').getValidToken()`

### Data Integrity

- **Drizzle ORM only**: All DOs use `drizzle-orm/durable-sqlite` - NEVER raw SQL
- **Zod validation**: Parse ALL external data at IO boundaries - no `as Type` casts
- **ISO8601 timestamps**: Store as TEXT, generate with `new Date().toISOString()`

### API Layer

- **Hono everywhere**: All routes (webhooks, REST, OAuth) use Hono router
- **Service bindings**: OAuth routes use service bindings for token exchange

---

## 5. Queue Messages

Discriminated union with `_tag` for exhaustive matching:

```typescript
type QueueMessage = SongRequestMessage | ChatCommandMessage | KeyboardRaffleMessage;

type SongRequestMessage = Readonly<{
	_tag: "SongRequest";
	eventId: string;
	rewardId: string;
	requesterDisplayName: string;
	spotifyUrl: string;
}>;

type ChatCommandMessage = Readonly<{
	_tag: "ChatCommand";
	command: "song" | "queue";
	requesterDisplayName: string;
}>;

type KeyboardRaffleMessage = Readonly<{
	_tag: "KeyboardRaffle";
	eventId: string;
	rewardId: string;
	requesterDisplayName: string;
}>;
```

---

## 6. Workflows

### 6.1 SongRequestWorkflow

Uses `cf-workflow-rollback` for compensating transactions:

```typescript
import { WorkflowEntrypoint } from "cloudflare:workers";
import { withRollback } from "cf-workflow-rollback";
import { Result, TaggedError } from "better-result";

class InvalidSpotifyUrl extends TaggedError {
	readonly _tag = "InvalidSpotifyUrl" as const;
	constructor(readonly url: string) {
		super(`Invalid Spotify URL: ${url}`);
	}
}

export class SongRequestWorkflow extends WorkflowEntrypoint<Env, SongRequestMessage> {
	async run(event, workflowStep) {
		const { eventId, rewardId, requesterDisplayName, spotifyUrl } = event.payload;
		const step = withRollback(workflowStep);
		const songQueue = this.env.SONG_QUEUE_DO.getByName("song-queue");

		try {
			// Step 1: Parse track ID from URL
			const trackId = await step.do("parse-url", async () => {
				const match = /\/track\/([a-zA-Z0-9]+)/.exec(spotifyUrl);
				if (!match?.[1]) throw new InvalidSpotifyUrl(spotifyUrl);
				return match[1];
			});

			// Step 2: Add to queue (with rollback)
			const { song } = await step.doWithRollback("add-to-queue", {
				run: async () => songQueue.addSongToQueue(trackId, requesterDisplayName),
				undo: async (_, result) => songQueue.revokeSongRequest(result.id),
			});

			// Step 3: Fulfill redemption
			await step.do(
				"fulfill",
				{ retries: { limit: 3, delay: "5s", backoff: "exponential" } },
				async () => this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "FULFILLED"),
			);

			// Step 4: Send confirmation
			await step.do(
				"chat",
				{ retries: { limit: 3, delay: "5s", backoff: "exponential" } },
				async () =>
					this.env.TWITCH.sendChatMessage(
						`@${requesterDisplayName} queued "${song.name}" by ${song.artists.join(", ")}`,
					),
			);
		} catch (error) {
			await step.rollbackAll(error);

			await step.do("refund", { retries: { limit: 3 } }, async () =>
				this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "CANCELED"),
			);

			await step.do("notify-failure", { retries: { limit: 3 } }, async () =>
				this.env.TWITCH.sendChatMessage(
					`@${requesterDisplayName} invalid song request. Points refunded.`,
				),
			);

			throw error;
		}
	}
}
```

### 6.2 ChatCommandWorkflow

```typescript
export class ChatCommandWorkflow extends WorkflowEntrypoint<Env, ChatCommandMessage> {
	async run(event, step) {
		const { command, requesterDisplayName } = event.payload;
		const songQueue = this.env.SONG_QUEUE_DO.getByName("song-queue");

		switch (command) {
			case "song": {
				const current = await step.do("get-current", () => songQueue.getCurrentlyPlaying());

				const message = current
					? `@${requesterDisplayName} Now playing: "${current.name}" by ${current.artists.join(", ")}`
					: `@${requesterDisplayName} Nothing playing`;

				await step.do("send-chat", { retries: { limit: 3 } }, () =>
					this.env.TWITCH.sendChatMessage(message),
				);
				break;
			}

			case "queue": {
				const queue = await step.do("get-queue", () => songQueue.getQueue(4));

				const message =
					queue.length > 0
						? `Next up: ${queue.map((t, i) => `${i + 1}. ${t.name}`).join(", ")}`
						: "Queue is empty";

				await step.do("send-chat", { retries: { limit: 3 } }, () =>
					this.env.TWITCH.sendChatMessage(message),
				);
				break;
			}
		}
	}
}
```

### 6.3 KeyboardRaffleWorkflow

```typescript
export class KeyboardRaffleWorkflow extends WorkflowEntrypoint<Env, KeyboardRaffleMessage> {
	async run(event, workflowStep) {
		const { eventId, rewardId, requesterDisplayName } = event.payload;
		const step = withRollback(workflowStep);
		const raffle = this.env.KEYBOARD_RAFFLE_DO.getByName("keyboard-raffle");

		try {
			const winningNumber = await step.do(
				"roll-winning",
				() => (crypto.getRandomValues(new Uint32Array(1))[0] % 10000) + 1,
			);

			const rolledNumber = await step.do(
				"roll-user",
				() => (crypto.getRandomValues(new Uint32Array(1))[0] % 10000) + 1,
			);

			const status = rolledNumber === winningNumber ? "won" : "lost";

			await step.doWithRollback("persist", {
				run: () =>
					raffle.recordRoll({
						userDisplayName: requesterDisplayName,
						roll: rolledNumber,
						winningNumber,
						status,
					}),
				undo: (_, id) => raffle.deleteRollById(id),
			});

			await step.do("fulfill", { retries: { limit: 3 } }, () =>
				this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "FULFILLED"),
			);

			const message =
				status === "won"
					? `@${requesterDisplayName} WON! Winning: ${winningNumber}, Rolled: ${rolledNumber}`
					: `@${requesterDisplayName} lost. Winning: ${winningNumber}, Rolled: ${rolledNumber}`;

			await step.do("chat", { retries: { limit: 3 } }, () =>
				this.env.TWITCH.sendChatMessage(message),
			);
		} catch (error) {
			await step.rollbackAll(error);

			await step.do("refund", { retries: { limit: 3 } }, () =>
				this.env.TWITCH.updateRedemptionStatus(rewardId, [eventId], "CANCELED"),
			);

			await step.do("notify-failure", { retries: { limit: 3 } }, () =>
				this.env.TWITCH.sendChatMessage(
					`@${requesterDisplayName} error occurred. Points refunded.`,
				),
			);

			throw error;
		}
	}
}
```

---

## 7. Durable Objects

### 7.0 Drizzle + DO Adapter

All DOs use Drizzle ORM with the official `drizzle-orm/durable-sqlite` adapter:

```typescript
import { drizzle } from "drizzle-orm/durable-sqlite";
import { DurableObject } from "cloudflare:workers";
import * as schema from "./schema";

export class SongQueueDO extends DurableObject {
	private db = drizzle(this.ctx.storage, { schema });

	async getQueue(limit = 10) {
		return this.db.query.songQueue.findMany({ limit });
	}
}
```

### 7.1 SongQueueDO

**Drizzle Schema:**

```typescript
// schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const tokenSet = sqliteTable("token_set", {
	id: integer("id")
		.primaryKey()
		.$check(sql`id = 1`),
	accessToken: text("access_token").notNull(),
	refreshToken: text("refresh_token").notNull(),
	tokenType: text("token_type").notNull(),
	expiresIn: integer("expires_in").notNull(),
	expiresAt: integer("expires_at").notNull(),
});

export const songQueue = sqliteTable("song_queue", {
	id: text("id").primaryKey(), // ulid
	spotifyTrackId: text("spotify_track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists", { mode: "json" }).notNull().$type<string[]>(),
	albumName: text("album_name").notNull(),
	albumCoverUrl: text("album_cover_url"),
	requesterDisplayName: text("requester_display_name"), // NULL = organic/synced
	addedAt: text("added_at").notNull(),
});

export const requestHistory = sqliteTable("request_history", {
	id: text("id").primaryKey(),
	spotifyTrackId: text("spotify_track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists", { mode: "json" }).notNull().$type<string[]>(),
	albumName: text("album_name").notNull(),
	requesterDisplayName: text("requester_display_name").notNull(),
	requestedAt: text("requested_at").notNull(),
	status: text("status", { enum: ["fulfilled", "refunded"] }).notNull(),
});
```

**Raw SQL equivalent (for reference):**

```sql
-- Spotify OAuth tokens (singleton)
CREATE TABLE token_set (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL,
  expires_in INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Active queue
CREATE TABLE song_queue (
  id TEXT PRIMARY KEY,  -- ulid
  spotify_track_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artists TEXT NOT NULL,  -- JSON array
  album_name TEXT NOT NULL,
  album_cover_url TEXT,
  requester_display_name TEXT,  -- NULL = organic/synced
  added_at TEXT NOT NULL
);

-- Request history (analytics source)
CREATE TABLE request_history (
  id TEXT PRIMARY KEY,
  spotify_track_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artists TEXT NOT NULL,
  album_name TEXT NOT NULL,
  requester_display_name TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fulfilled', 'refunded'))
);

-- Indexes for analytics queries
CREATE INDEX idx_request_history_track ON request_history(spotify_track_id);
CREATE INDEX idx_request_history_requester ON request_history(requester_display_name);
CREATE INDEX idx_request_history_requested_at ON request_history(requested_at);
```

**RPC Methods:**

```typescript
interface SongQueueDO {
  // Reads
  getCurrentlyPlaying(): Promise<TrackInfo | null>;
  getQueue(limit?: number): Promise<QueueItem[]>;

  // Writes
  addSongToQueue(trackId: string, requester: string): Promise<{ id: string; song: TrackInfo }>;
  revokeSongRequest(id: string): Promise<void>;

  // Analytics
  getRequestHistory(opts: {
    limit?: number;
    offset?: number;
    since?: Date;
    until?: Date;
  }): Promise<RequestHistoryItem[]>;

  getTopTracks(opts: {
    limit?: number;
    since?: Date;
  }): Promise<Array<{ track: TrackInfo; count: number }>>;

  getTopTracksByUser(opts: {
    userDisplayName: string;
    limit?: number;
  }): Promise<Array<{ track: TrackInfo; count: number }>>;

  getTopRequesters(opts: {
    limit?: number;
    since?: Date;
  }): Promise<Array<{ userDisplayName: string; count: number }>>;

  // Internal
  private getSpotify(): SpotifyApi;  // Lazy init with token refresh
}
```

### 7.2 KeyboardRaffleDO

**SQLite Schema:**

```sql
CREATE TABLE rolls (
  id TEXT PRIMARY KEY,
  user_display_name TEXT NOT NULL,
  roll INTEGER NOT NULL,
  winning_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('won', 'lost')),
  rolled_at TEXT NOT NULL
);
```

**RPC Methods:**

```typescript
interface KeyboardRaffleDO {
	recordRoll(roll: Roll): Promise<string>;
	getRollById(id: string): Promise<Roll | null>;
	deleteRollById(id: string): Promise<void>;
}
```

### 7.3 TwitchTokenDO

Mirrors Spotify token pattern for consistent token management across both APIs.

**SQLite Schema:**

```sql
CREATE TABLE token_set (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL,
  expires_in INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

**RPC Methods:**

```typescript
interface TwitchTokenDO {
	getTokens(): Promise<TokenSet | null>;
	setTokens(tokens: TokenSet): Promise<void>;
	refreshTokens(): Promise<TokenSet>; // Calls Twitch OAuth, persists, returns
}
```

---

## 8. Twitch Integration

### 8.1 OAuth Scopes

```typescript
const TWITCH_SCOPES = [
	"bits:read",
	"channel:bot",
	"channel:manage:broadcast",
	"channel:manage:redemptions",
	"channel:read:redemptions",
	"chat:edit",
	"chat:read",
	"moderator:read:chatters",
	"user:bot",
	"user:edit",
	"user:write:chat",
	"user:read:chat",
];
```

### 8.2 EventSub Subscriptions

| Event Type                                            | Purpose                       |
| ----------------------------------------------------- | ----------------------------- |
| `channel.channel_points_custom_reward_redemption.add` | Song request, Keyboard raffle |
| `channel.chat.message`                                | !song, !queue commands        |

### 8.3 Webhook Middleware (Hono)

```typescript
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";

export const twitchWebhook = createMiddleware(async (c, next) => {
	const headers = parseTwitchHeaders(c.req.raw.headers);
	if (!headers.success) return c.json({ error: "Invalid headers" }, 400);

	const rawBody = await c.req.text();
	const message = `${headers.data.messageId}${headers.data.messageTimestamp}${rawBody}`;

	const expected = `sha256=${hmacSha256(c.env.TWITCH_WEBHOOK_SECRET, message)}`;
	const actual = headers.data.messageSignature;

	if (!timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
		return c.json({ error: "Invalid signature" }, 403);
	}

	c.set("twitchHeaders", headers.data);
	c.set("twitchRawBody", rawBody);
	await next();
});
```

### 8.4 Twitch Service (Plain Class)

Services are plain classes instantiated directly - NOT WorkerEntrypoint service bindings:

```typescript
import { Result } from "better-result";
import { getStub } from "../lib/durable-objects";

export class TwitchService {
	constructor(public env: Env) {}

	async sendChatMessage(message: string): Promise<Result<void, TwitchError>> {
		const tokenResult = await this.getToken();
		if (tokenResult.status === "error") return Result.err(tokenResult.error);

		// Use Result.tryPromise with retries...
	}

	async updateRedemptionStatus(
		rewardId: string,
		redemptionId: string,
		status: "FULFILLED" | "CANCELED",
	): Promise<Result<void, TwitchError>> {
		// Similar pattern...
	}

	private async getToken() {
		return getStub("TWITCH_TOKEN_DO").getValidToken();
	}
}
```

---

## 9. Spotify Integration

### 9.1 Vendored SDK

Use vendored `@spotify/web-api-ts-sdk` from `../cf-twitch-old/vendor/` with server-side token refresh:

- `AccessTokenHelpers.refreshCachedAccessToken()` - Basic auth refresh
- `ProvidedAccessTokenStrategy` - accepts `clientSecret`
- Token persistence in SongQueueDO SQLite

### 9.2 OAuth Scopes

```typescript
const SPOTIFY_SCOPES = [
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-read-currently-playing",
	"app-remote-control",
	"streaming",
	"playlist-read-private",
	"playlist-read-collaborative",
	"playlist-modify-private",
	"playlist-modify-public",
	"user-read-playback-position",
	"user-top-read",
	"user-read-recently-played",
	"user-library-modify",
	"user-library-read",
	"user-read-email",
	"user-read-private",
];
```

### 9.3 API Operations

| Operation                            | Use Case        |
| ------------------------------------ | --------------- |
| `player.addItemToPlaybackQueue(uri)` | Song requests   |
| `player.getCurrentlyPlayingTrack()`  | !song, overlays |
| `player.getUsersQueue()`             | Queue sync      |
| `tracks.get(id)`                     | Track metadata  |

---

## 10. Overlays (TanStack Start)

### 10.1 Structure

```
apps/overlays/
├── app/
│   ├── routes/
│   │   ├── __root.tsx
│   │   ├── now-playing.tsx
│   │   └── queue.tsx
│   └── components/
│       ├── NowPlaying.tsx
│       └── QueueList.tsx
├── vite.config.ts
├── wrangler.jsonc
└── package.json
```

### 10.2 Vite Config

```typescript
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		tanstackStart(),
		react(),
		tailwindcss(),
	],
});
```

### 10.3 Data Fetching

```typescript
import { createServerFn } from "@tanstack/react-start";
import { getCloudflareContext } from "@cloudflare/vite-plugin";

const fetchQueue = createServerFn().handler(async () => {
	const { env } = await getCloudflareContext();
	// Service binding to cf-twitch-api
	const res = await env.API.fetch(new Request("http://internal/api/queue"));
	return res.json();
});
```

---

## 11. Configuration

### 11.1 wrangler.jsonc (cf-twitch-api)

```jsonc
{
	"name": "cf-twitch-api",
	"main": "src/index.ts",
	"compatibility_date": "2025-01-01",
	"compatibility_flags": ["nodejs_compat"],

	"durable_objects": {
		"bindings": [
			{ "name": "SONG_QUEUE_DO", "class_name": "SongQueueDO" },
			{ "name": "KEYBOARD_RAFFLE_DO", "class_name": "KeyboardRaffleDO" },
			{ "name": "TWITCH_TOKEN_DO", "class_name": "TwitchTokenDO" },
		],
	},

	"migrations": [
		{ "tag": "v1", "new_sqlite_classes": ["SongQueueDO", "KeyboardRaffleDO", "TwitchTokenDO"] },
	],

	"workflows": [
		{
			"name": "song-request-wf",
			"binding": "SONG_REQUEST_WF",
			"class_name": "SongRequestWorkflow",
		},
		{
			"name": "chat-command-wf",
			"binding": "CHAT_COMMAND_WF",
			"class_name": "ChatCommandWorkflow",
		},
		{
			"name": "keyboard-raffle-wf",
			"binding": "KEYBOARD_RAFFLE_WF",
			"class_name": "KeyboardRaffleWorkflow",
		},
	],

	"queues": {
		"producers": [{ "binding": "QUEUE", "queue": "cf-twitch-queue" }],
		"consumers": [{ "queue": "cf-twitch-queue" }],
	},

	"services": [{ "binding": "TWITCH", "service": "cf-twitch-api", "entrypoint": "TwitchService" }],

	"vars": {
		"TWITCH_CLIENT_ID": "YOUR_TWITCH_CLIENT_ID",
		"TWITCH_BROADCASTER_ID": "209286766",
		"TWITCH_BROADCASTER_NAME": "dmmulroy",
		"SONG_REQUEST_REWARD_ID": "c2063c79-a24c-4b17-94f7-c871f2876708",
		"KEYBOARD_RAFFLE_REWARD_ID": "29afa291-244a-47a8-8be8-ded13995e83d",
	},
	// Secrets: TWITCH_CLIENT_SECRET, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN,
	//          TWITCH_WEBHOOK_SECRET, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
	//          SPOTIFY_ACCESS_TOKEN, SPOTIFY_REFRESH_TOKEN
}
```

### 11.2 wrangler.jsonc (cf-twitch-overlays)

```jsonc
{
	"name": "cf-twitch-overlays",
	"main": "@tanstack/react-start/server-entry",
	"compatibility_date": "2025-01-01",
	"compatibility_flags": ["nodejs_compat"],

	"services": [{ "binding": "API", "service": "cf-twitch-api" }],
}
```

---

## 12. Directory Structure

```
cf-twitch/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts              # Worker entry + exports
│   │   │   ├── server.ts             # Hono app
│   │   │   ├── queue-consumer.ts     # Queue handler
│   │   │   ├── durable-objects/
│   │   │   │   ├── song-queue/
│   │   │   │   │   ├── song-queue-do.ts
│   │   │   │   │   └── schema.ts     # Drizzle schema
│   │   │   │   ├── keyboard-raffle/
│   │   │   │   │   ├── keyboard-raffle-do.ts
│   │   │   │   │   └── schema.ts
│   │   │   │   └── twitch-token/
│   │   │   │       ├── twitch-token-do.ts
│   │   │   │       └── schema.ts
│   │   │   ├── workflows/
│   │   │   │   ├── song-request.ts
│   │   │   │   ├── chat-command.ts
│   │   │   │   └── keyboard-raffle.ts
│   │   │   ├── services/
│   │   │   │   └── twitch-service.ts # WorkerEntrypoint
│   │   │   └── lib/
│   │   │       ├── twitch/
│   │   │       │   ├── middleware.ts
│   │   │       │   └── schemas.ts    # Zod EventSub schemas
│   │   │       └── spotify/
│   │   │           └── client.ts
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   │
│   └── overlays/
│       ├── app/
│       │   └── routes/
│       ├── vite.config.ts
│       ├── wrangler.jsonc
│       └── package.json
│
├── vendor/
│   └── spotify-web-api-ts-sdk/       # Copied from cf-twitch-old
│
├── package.json                       # Workspace root
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## 13. Decisions

| Question             | Decision                                                  |
| -------------------- | --------------------------------------------------------- |
| Queue sync           | On-demand (overlay fetch, !song, !queue, song request)    |
| Twitch tokens        | DO-persisted (new TwitchTokenDO, mirrors Spotify pattern) |
| Overlay updates      | Polling                                                   |
| Monorepo             | pnpm workspaces                                           |
| Service binding auth | None needed (internal-only)                               |

---

## 14. Open Questions

1. **TwitchTokenDO location** - Separate DO or embed in TwitchService itself?
2. **Shared types package** - Create `packages/shared` for QueueMessage, TrackInfo, etc., or inline in api?
3. **Spotify queue sync trigger** - On every `getCurrentlyPlaying()` call, or separate `syncQueue()` method?
4. **Chat commands for stats** - `!toptracks`, `!mystats` in v1 scope?
5. **Stats API auth** - Public or require some auth for analytics endpoints?

---

## 15. Error Handling Patterns

### 15.1 TaggedError Base Class

All domain errors extend `TaggedError` from better-result:

```typescript
import { TaggedError } from "better-result";

export class InvalidSpotifyUrl extends TaggedError {
	readonly _tag = "InvalidSpotifyUrl";
	constructor(readonly url: string) {
		super(`Invalid Spotify URL: ${url}`);
	}
}

export class SpotifyApiError extends TaggedError {
	readonly _tag = "SpotifyApiError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export class DurableObjectError extends TaggedError {
	readonly _tag = "DurableObjectError";
	constructor(
		readonly method: string,
		readonly cause: unknown,
	) {
		super(`DO call failed: ${method}`);
	}

	static from(error: unknown, method: string) {
		return new DurableObjectError(method, error);
	}
}
```

### 15.2 DO Stub Result Serde (getStub)

Use `getStub()` from `lib/durable-objects.ts` to get typed DO stubs with automatic Result deserialization:

```typescript
// lib/durable-objects.ts
import { Result } from "better-result";
import { env } from "cloudflare:workers";
import { DurableObjectError } from "./errors";

// Singleton ID mapping for common DOs
const SINGLETON_IDS: Record<string, string> = {
	SPOTIFY_TOKEN_DO: "spotify-token",
	TWITCH_TOKEN_DO: "twitch-token",
	STREAM_LIFECYCLE_DO: "stream-lifecycle",
	// ...
};

/**
 * Get a typed DO stub with Result deserialization.
 * Uses `env` from cloudflare:workers - no need to pass it.
 */
export function getStub<K extends DONamespaceKeys>(
	key: K,
	id?: string,
): DeserializedStub<ExtractDO<K>> {
	const namespace = (env as Env)[key];
	const resolvedId = id ?? SINGLETON_IDS[key];
	const doId = namespace.idFromName(resolvedId);
	const stub = namespace.get(doId);
	return wrapStub(stub);
}

// Proxy wrapper that:
// 1. Calls Result.hydrate() on return values
// 2. Wraps non-Result returns in Result.ok()
// 3. Catches DO errors and wraps in DurableObjectError
```

**Usage:**

```typescript
// Singleton DO (uses mapped ID)
const stub = getStub("SPOTIFY_TOKEN_DO");
const result = await stub.getValidToken();
// result: Result<string, TokenError | DurableObjectError>

// Custom ID
const stub = getStub("SONG_QUEUE_DO", "custom-queue-id");
```

---

## 16. Dependencies

```json
{
	"dependencies": {
		"hono": "^4.11.3",
		"better-result": "^1.0.0",
		"drizzle-orm": "^0.38.0",
		"@twurple/api": "^7.2.0",
		"@twurple/auth": "^7.2.0",
		"zod": "^3.24.0"
	},
	"devDependencies": {
		"cf-workflow-rollback": "^1.5.0",
		"@cloudflare/vite-plugin": "^1.0.0",
		"wrangler": "^4.0.0",
		"drizzle-kit": "^0.30.0",
		"typescript": "^5.7.0"
	}
}
```

**Note:** Cloudflare Workers types are auto-generated via `wrangler types` command. Run after modifying `wrangler.jsonc` to regenerate `worker-configuration.d.ts`.

```

---

## 17. Success Metrics

- Webhook response time < 100ms (p99)
- Workflow completion rate > 99.5%
- Zero dropped redemptions (queue + workflow durability)
- Overlay load time < 500ms
```
