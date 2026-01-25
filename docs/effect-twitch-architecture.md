# Effect Twitch Integrations - Architecture & PRD

**Version:** 1.0  
**Last Updated:** 2026-01-12

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Core Services](#core-services)
4. [PubSub Message System](#pubsub-message-system)
5. [Twitch Integration](#twitch-integration)
6. [Spotify Integration](#spotify-integration)
7. [Song Queue System](#song-queue-system)
8. [API Server](#api-server)
9. [Overlays (SvelteKit)](#overlays-sveltekit)
10. [Effect Patterns Reference](#effect-patterns-reference)
11. [Data Flow Diagrams](#data-flow-diagrams)
12. [Configuration](#configuration)
13. [Known Issues & TODOs](#known-issues--todos)

---

## Overview

Twitch integration service for live streaming. Connects Twitch chat/channel points to Spotify playback.

### Features

| Feature           | Trigger              | Description                 |
| ----------------- | -------------------- | --------------------------- |
| Song Request      | Channel Points       | Queue Spotify track via URL |
| Currently Playing | `!song` command      | Show current track in chat  |
| Queue Display     | `!queue` command     | Show next 4 tracks in chat  |
| Keyboard Raffle   | Channel Points       | 1/10000 chance raffle       |
| Nix Timer         | `!nix` (broadcaster) | Track time configuring Nix  |
| Stream Overlays   | HTTP/SSE             | Now playing widget for OBS  |

### Tech Stack

```
Runtime:     Bun
Framework:   Effect-TS
Twitch:      Twurple (EventSub WebSocket)
Spotify:     Vendored @spotify/web-api-ts-sdk
Overlays:    SvelteKit (Vercel)
Backend:     Fly.io
```

---

## System Architecture

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SERVICES                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐          │
│   │   Twitch    │         │   Spotify   │         │   Vercel    │          │
│   │  EventSub   │         │    API      │         │  (Overlays) │          │
│   └──────┬──────┘         └──────┬──────┘         └──────┬──────┘          │
│          │                       │                       │                  │
└──────────│───────────────────────│───────────────────────│──────────────────┘
           │ WebSocket             │ HTTPS                 │ HTTPS
           │                       │                       │
┌──────────│───────────────────────│───────────────────────│──────────────────┐
│          ▼                       ▼                       │                  │
│   ┌─────────────┐         ┌─────────────┐               │                  │
│   │TwitchEvent- │         │SpotifyApi-  │               │                  │
│   │SubClient    │         │Client       │               │                  │
│   └──────┬──────┘         └──────┬──────┘               │                  │
│          │                       │                       │                  │
│          │         ┌─────────────┼───────────────────────┤                  │
│          │         │             │                       │                  │
│          ▼         ▼             ▼                       ▼                  │
│   ┌──────────────────────────────────────────────────────────────────┐     │
│   │                      PubSubClient                                 │     │
│   │               (In-Memory Message Bus)                             │     │
│   │                                                                   │     │
│   │  Publishers:                  Subscribers:                        │     │
│   │  - EventSub handlers          - CurrentlyPlayingRequest           │     │
│   │  - Subscriber responses       - SongRequest                       │     │
│   │                               - SongQueue                         │     │
│   │                               - SendTwitchChat                    │     │
│   │                               - RefundReward                      │     │
│   │                               - KeyboardRaffle                    │     │
│   │                               - ToggleNixTimer                    │     │
│   └──────────────────────────────────────────────────────────────────┘     │
│          │                       │                       │                  │
│          ▼                       ▼                       ▼                  │
│   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐          │
│   │SongQueue-   │         │NixTimer-    │         │ API Server  │◄─────────┤
│   │Client       │         │Client       │         │  :3000      │          │
│   └─────────────┘         └─────────────┘         └─────────────┘          │
│                                                                             │
│                            EFFECT-TS APPLICATION                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Layer Composition (Entry Point)

```typescript
// src/main.ts

const MainLive = Layer.mergeAll(
	TwitchService, // EventSub + API
	SpotifyService, // Spotify wrapper
	PubSubSubscribers, // All 9 message handlers
	ApiServer, // HTTP :3000
).pipe(Layer.provide(SongQueueClient.Live), Layer.provide(NixTimerClient.Live));

BunRuntime.runMain(Layer.launch(MainLive));
```

### Dependency Graph

```
MainLive
├── TwitchService
│   ├── TwitchEventSubSubscribers
│   │   ├── ChannelChatMessageSubscriber
│   │   │   ├── TwitchEventSubClient ─── TwitchApiClient ─── TwitchAuthProvider
│   │   │   └── PubSubClient
│   │   └── ChannelRedemptionAddForReward
│   │       ├── TwitchEventSubClient
│   │       └── PubSubClient
│   └── PubSubClient
│
├── SpotifyService
│   ├── SpotifyApiClient
│   └── PubSubClient
│
├── PubSubSubscribers (9 subscribers)
│   ├── CurrentlyPlayingRequestSubscriber ─── SpotifyApiClient, PubSubClient
│   ├── CurrentlyPlayingSubscriber ─── PubSubClient
│   ├── SongRequestSubscriber ─── SpotifyApiClient, TwitchApiClient, PubSubClient
│   ├── SongQueueRequestSubscriber ─── SongQueueClient, PubSubClient
│   ├── SongQueueSubscriber ─── TwitchApiClient, PubSubClient
│   ├── SendTwitchShatSubscriber ─── TwitchApiClient, PubSubClient
│   ├── RefundRewardSubscriber ─── TwitchApiClient, PubSubClient
│   ├── KeyboardRaffleSubscriber ─── TwitchApiClient, PubSubClient
│   └── NixTimerSubscriber ─── NixTimerClient, PubSubClient
│
├── ApiServer
│   ├── SongQueueClient
│   └── NixTimerClient
│
├── SongQueueClient (shared)
│   ├── PubSubClient
│   ├── SpotifyApiClient
│   └── BunFileSystem
│
└── NixTimerClient (shared)
    └── BunFileSystem
```

---

## Core Services

### Service Definition Pattern

All services follow 3-part pattern:

```typescript
// 1. Interface type
type IServiceName = Readonly<{
	method: () => Effect.Effect<A, E, R>;
}>;

// 2. Private make function
const make = Effect.gen(function* () {
	// acquire dependencies
	// build service
	return {
		/* methods */
	} as const;
}).pipe(Effect.annotateLogs({ module: "service-name" }));

// 3. Class with Tag + Live layer
class ServiceName extends Context.Tag("service-name")<ServiceName, IServiceName>() {
	static Live = Layer.scoped(this, make).pipe(Layer.provide(Dependency.Live));
}
```

### PubSubClient

In-memory message bus using Effect's `PubSub`.

```typescript
// src/pubsub/client.ts

type IPubSubService = Readonly<{
	publish: (message: Message) => Effect.Effect<boolean>;
	unsafePublish: (message: Message) => boolean; // Sync for callbacks
	subscribe: () => Effect.Effect<Queue.Dequeue<Message>, never, Scope.Scope>;
	subscribeTo: <T extends MessageType>(
		messageType: T,
	) => Effect.Effect<Queue.Dequeue<MessageTypeToMessage[T]>, never, Scope.Scope>;
}>;
```

**Key Implementation - Type-Safe Filtered Subscription:**

```typescript
subscribeTo: <T extends MessageType>(messageType: T) =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(
      Queue.unbounded<MessageTypeToMessage[T]>(),
      (queue) => Queue.shutdown(queue),
    );
    const subscription = yield* PubSub.subscribe(pubsub);

    function predicate(message: Message): message is MessageTypeToMessage[T] {
      return message._tag === messageType;
    }

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const message = yield* subscription.take;
          if (predicate(message)) {
            yield* Queue.offer(queue, message);
          }
        }),
      ),
    );
    return queue;
  }),
```

### TwitchApiClient

Wraps Twurple `ApiClient` with Effect error handling.

```typescript
// src/twitch/api.ts

type ITwitchApiClient = Readonly<{
	client: ApiClient;
	use: <A>(fn: (client: ApiClient) => Promise<A>) => Effect.Effect<A, TwitchError>;
}>;

const make = Effect.gen(function* () {
	const authProvider = yield* TwitchAuthProvider;
	const client = new ApiClient({ authProvider });

	const use = <A>(f: (client: ApiClient) => Promise<A>) =>
		Effect.tryPromise({
			try: () => f(client),
			catch: (error) => new TwitchError({ cause: error }),
		});

	return { use, client } as const;
});
```

### SpotifyApiClient

Wraps vendored Spotify SDK with auto token refresh.

```typescript
// src/spotify/api.ts

type ISpotifyApiClient = Readonly<{
	client: SpotifyApi;
	use: <A>(fn: (client: SpotifyApi) => Promise<A>) => Effect.Effect<A, SpotifyError>;
}>;

const make = Effect.gen(function* () {
	const config = yield* SpotifyConfig;

	const client = SpotifyApi.withAccessToken(
		config.clientId,
		Redacted.value(config.clientSecret),
		config.accessToken,
	);

	// Custom refresh callback persists token to disk
	client.switchAuthenticationStrategy(
		new ProvidedAccessTokenStrategy(
			config.clientId,
			Redacted.value(config.clientSecret),
			config.accessToken,
			async (clientId, clientSecret, accessToken) => {
				const refreshed = await AccessTokenHelpers.refreshCachedAccessToken(
					clientId,
					clientSecret,
					accessToken,
				);
				await Bun.write(
					"src/do_not_open_on_stream/access-token.json",
					JSON.stringify(refreshed, null, 2),
				);
				return refreshed;
			},
		),
	);

	const use = <A>(fn: (client: SpotifyApi) => Promise<A>) =>
		Effect.tryPromise({
			try: () => fn(client),
			catch: (cause) => new SpotifyError({ cause: String(cause) }),
		});

	return { use, client } as const;
});
```

### SongQueueClient

Maintains queue state synchronized with Spotify, persisted to JSON.

```typescript
// src/song-queue/client.ts

type QueueItem = Readonly<{
	track: TrackItem;
	requesterDisplayName: Option.Option<string>; // None = organic play
}>;

type ISongQueue = Readonly<{
	getQueue: () => Effect.Effect<ReadonlyArray<QueueItem>, SpotifyError | PersistSongQueueError>;
}>;
```

**Sync Algorithm:**

```
Local Queue                    Spotify Queue
┌────────────────────┐        ┌────────────────────┐
│ Track A (@user1)   │   ──▶  │ Track A (current)  │  ✓ Match
│ Track B (@user2)   │   ──▶  │ Track B            │  ✓ Match
│ Track C (stale)    │   ╳    │ Track D (organic)  │  + Add (no requester)
└────────────────────┘        │ Track E (organic)  │  + Add (no requester)
                              └────────────────────┘

Result: [A/@user1, B/@user2, D/None, E/None]
```

### NixTimerClient

Tracks time spent configuring Nix, persisted across restarts.

```typescript
// src/nix-timer/client.ts

type NixTimerState = {
	currentTimerStartTime: number | undefined; // undefined = stopped
	totalTime: number;
};

type INixTimer = Readonly<{
	isRunning: () => Effect.Effect<boolean>;
	start: () => Effect.Effect<void, TimerAlreadyRunningError>;
	stop: () => Effect.Effect<void, TimerNotRunningError>;
	getTotalTime: () => Effect.Effect<number>;
	getCurrentTimerStartTime: () => Effect.Effect<number | undefined>;
}>;

// Persistence path detection (Fly.io volume vs local)
const volumeMountExists = yield * fs.exists("/data/nix_timer/persistence.json");
const path = volumeMountExists
	? "/data/nix_timer/persistence.json"
	: "src/nix-timer/persistence.json";
```

---

## PubSub Message System

### Message Types (ADT)

```typescript
// src/pubsub/messages.ts

type Message = Data.TaggedEnum<{
	// Requests (trigger actions)
	CurrentlyPlayingRequest: { requesterDisplayName: string };
	SongRequest: { eventId: string; requesterDisplayName: string; rewardId: string; url: string };
	SongQueueRequest: {};
	KeyboardRaffleRequest: { requesterDisplayName: string; eventId: string; rewardId: string };
	ToggleNixTimer: {};
	RefundRewardRequest: { eventId: string; requesterDisplayName: string; rewardId: string };

	// Responses (carry data)
	CurrentlyPlaying: { song: string; artists: ReadonlyArray<string>; requesterDisplayName: string };
	SongQueue: { queue: ReadonlyArray<QueueItem> };
	SongAddedToSpotifyQueue: { track: TrackItem; requesterDisplayName: string };

	// Actions
	SendTwitchChat: { message: string };
}>;

export const Message = Data.taggedEnum<Message>();
```

### Message Flow Matrix

```
┌─────────────────────────┬──────────────────────────┬───────────────────────────────┐
│ Message                 │ Publisher                │ Subscriber(s)                 │
├─────────────────────────┼──────────────────────────┼───────────────────────────────┤
│ CurrentlyPlayingRequest │ Chat (!song)             │ CurrentlyPlayingRequestSub    │
│ CurrentlyPlaying        │ CurrentlyPlayingReqSub   │ CurrentlyPlayingSub           │
│ SongRequest             │ Channel Points           │ SongRequestSub                │
│ SongQueueRequest        │ Chat (!queue)            │ SongQueueRequestSub           │
│ SongQueue               │ SongQueueRequestSub      │ SongQueueSub                  │
│ SendTwitchChat          │ Multiple                 │ SendTwitchShatSub             │
│ RefundRewardRequest     │ SongRequestSub (error)   │ RefundRewardSub               │
│ KeyboardRaffleRequest   │ Channel Points           │ KeyboardRaffleSub             │
│ ToggleNixTimer          │ Chat (!nix)              │ NixTimerSub                   │
│ SongAddedToSpotifyQueue │ SongRequestSub           │ ⚠️ DEAD CODE (no subscriber)  │
└─────────────────────────┴──────────────────────────┴───────────────────────────────┘
```

### Subscriber Pattern

```typescript
// Template for all subscribers

const make = Effect.gen(function* () {
	yield* Effect.logInfo("Starting XxxSubscriber");

	const pubsub = yield* PubSubClient;
	const subscriber = yield* pubsub.subscribeTo("MessageType");

	yield* Effect.forkScoped(
		Effect.forever(
			Effect.gen(function* () {
				const message = yield* Queue.take(subscriber);
				// Handle message...
			}).pipe(Effect.catchAll(() => Effect.void)), // Error resilience
		),
	);

	yield* Effect.acquireRelease(Effect.logInfo("XxxSubscriber started"), () =>
		Effect.logInfo("XxxSubscriber stopped"),
	);
}).pipe(Effect.annotateLogs({ module: "xxx-subscriber" }));

export const XxxSubscriber = Layer.scopedDiscard(make).pipe(Layer.provide(PubSubClient.Live));
```

---

## Twitch Integration

### EventSub Events

| Event                    | Handler                                | Actions                          |
| ------------------------ | -------------------------------------- | -------------------------------- |
| `onChannelChatMessage`   | `channel-chat-message.ts`              | Parse commands, publish messages |
| `onChannelRedemptionAdd` | `channel-redemption-add-for-reward.ts` | Route by reward ID               |

### Chat Commands

```typescript
// src/twitch/eventsub-subscribers/channel-chat-message.ts

function createMatchCommand(pubsub: IPubSubService) {
	return function (input: { requesterDisplayName: string; message: string }) {
		Match.value(input).pipe(
			Match.when({ message: "!song" }, ({ requesterDisplayName }) => {
				pubsub.unsafePublish(Message.CurrentlyPlayingRequest({ requesterDisplayName }));
			}),
			Match.when({ message: "!queue" }, () => {
				pubsub.unsafePublish(Message.SongQueueRequest());
			}),
			Match.when({ message: "!nix", requesterDisplayName: "dmmulroy" }, () => {
				pubsub.unsafePublish(Message.ToggleNixTimer());
			}),
		);
	};
}
```

### Channel Point Rewards

| Reward          | ID             | Action                          |
| --------------- | -------------- | ------------------------------- |
| Song Request    | `c2063c79-...` | Publish `SongRequest`           |
| Keyboard Raffle | `29afa291-...` | Publish `KeyboardRaffleRequest` |

```typescript
// src/twitch/eventsub-subscribers/channel-redemption-add-for-reward.ts

eventsub.onChannelRedemptionAdd(config.broadcasterId, (event) => {
	switch (event.rewardId) {
		case config.songRequestRewardId:
			return pubsub.unsafePublish(
				Message.SongRequest({
					eventId: event.id,
					rewardId: event.rewardId,
					requesterDisplayName: event.userDisplayName,
					url: event.input,
				}),
			);
		case config.keyboardRaffleRewardId:
			return pubsub.unsafePublish(
				Message.KeyboardRaffleRequest({
					requesterDisplayName: event.userDisplayName,
					eventId: event.id,
					rewardId: event.rewardId,
				}),
			);
	}
});
```

### Auth Flow

```
┌──────────────────┐
│ TwitchAuthProvider│
├──────────────────┤
│                  │
│  ┌────────────┐  │    ┌─────────────┐
│  │Refreshing  │──┼───▶│ TwitchApi   │
│  │AuthProvider│  │    │ Client      │
│  └────────────┘  │    └─────────────┘
│        │         │           │
│        ▼         │           ▼
│  Auto-refresh    │    ┌─────────────┐
│  on expiry       │    │ EventSub    │
│                  │    │ WebSocket   │
└──────────────────┘    └─────────────┘
```

---

## Spotify Integration

### Vendored SDK

Official SDK only supports PKCE (browser). Fork adds `clientSecret` for server-side refresh.

**Path Alias:** `@spotify/web-api-ts-sdk` → `./vendor/spotify-web-api-ts-sdk/`

**Key Changes:**

```typescript
// AccessTokenHelpers.ts - Basic auth for server-side
private static async refreshToken(clientId, clientSecret, refreshToken) {
  const result = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: params,
  });
}

// ProvidedAccessTokenStrategy.ts - Accepts clientSecret
constructor(
  protected clientId: string,
  protected clientSecret: string,  // ADDED
  protected accessToken: AccessToken,
  refreshTokenAction?: (...) => Promise<AccessToken>,
) {}

// SpotifyApi.ts - Factory accepts clientSecret
static withAccessToken(
  clientId: string,
  clientSecret: string,  // ADDED
  token: AccessToken,
) {}
```

### Token Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     INITIAL SETUP                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  bun run get-spotify-access-token                               │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────────┐  │
│  │ Open    │───▶│ User    │───▶│ Redirect│───▶│ Save token  │  │
│  │ browser │    │ consent │    │ callback│    │ to JSON     │  │
│  └─────────┘    └─────────┘    └─────────┘    └─────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     RUNTIME REFRESH                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  API call with expired token                                    │
│       │                                                         │
│       ▼                                                         │
│  ProvidedAccessTokenStrategy.getOrCreateAccessToken()           │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐ │
│  │ Check expiry    │───▶│ POST /api/token │───▶│ Save to     │ │
│  │ (expires field) │    │ (Basic auth)    │    │ access-     │ │
│  └─────────────────┘    └─────────────────┘    │ token.json  │ │
│                                                 └─────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Operations Used

| Operation                            | Use Case        |
| ------------------------------------ | --------------- |
| `player.addItemToPlaybackQueue(uri)` | Song requests   |
| `player.getCurrentlyPlayingTrack()`  | `!song` command |
| `player.getUsersQueue()`             | Queue sync      |
| `tracks.get(id)`                     | Track metadata  |

---

## Song Queue System

### Queue Item Schema

```typescript
type QueueItem = Readonly<{
	track: TrackItem; // Spotify track object
	requesterDisplayName: Option.Option<string>; // Some = requested, None = organic
}>;
```

### Sync Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         EVERY 5 SECONDS                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────┐                    ┌──────────────────┐           │
│  │   Local Queue    │                    │  Spotify Queue   │           │
│  │  (with requester │    RECONCILE       │  (from API)      │           │
│  │   attribution)   │◄──────────────────▶│                  │           │
│  └──────────────────┘                    └──────────────────┘           │
│           │                                       │                      │
│           │                                       │                      │
│           ▼                                       ▼                      │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                     QUEUE REDUCER                                   │ │
│  │                                                                     │ │
│  │  for each track in Spotify queue:                                   │ │
│  │    if track.id exists in local queue:                              │ │
│  │      keep requester attribution                                    │ │
│  │    else:                                                           │ │
│  │      add with Option.none() (organic play)                         │ │
│  │                                                                     │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│           │                                                              │
│           ▼                                                              │
│  ┌──────────────────┐                                                   │
│  │ persistence.json │                                                   │
│  └──────────────────┘                                                   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Persistence Format

```json
[
	{
		"track": {
			"id": "1db6ixe9nX6cqt2V1DYZnW",
			"name": "Am I High Rn",
			"artists": [{ "name": "DJ Khaled" }],
			"album": { "name": "GOD DID" }
		},
		"requesterDisplayName": {
			"_id": "Option",
			"_tag": "Some",
			"value": "dmmulroy"
		}
	},
	{
		"track": { "id": "2TfSHkHiFO4gRztVIkggkE", "name": "Sugar, We're Goin Down" },
		"requesterDisplayName": { "_id": "Option", "_tag": "None" }
	}
]
```

---

## API Server

### Endpoints

```typescript
// src/api/server.ts

const router = HttpServer.router.empty.pipe(
	HttpServer.router.get("/ping", HttpServer.response.text("pong")),

	HttpServer.router.get(
		"/nix-timer",
		Effect.gen(function* () {
			const timer = yield* NixTimerClient;
			return yield* HttpServer.response.json({
				data: {
					currentStartTime: yield* timer.getCurrentTimerStartTime(),
					totalTime: yield* timer.getTotalTime(),
				},
			});
		}),
	),

	HttpServer.router.get(
		"/song-queue",
		Effect.gen(function* () {
			const client = yield* SongQueueClient;
			const queue = yield* client.getQueue();
			return yield* HttpServer.response.json({ data: queue });
		}),
	),
);
```

| Method | Path          | Response                                    |
| ------ | ------------- | ------------------------------------------- |
| GET    | `/ping`       | `"pong"`                                    |
| GET    | `/nix-timer`  | `{ data: { currentStartTime, totalTime } }` |
| GET    | `/song-queue` | `{ data: QueueItem[] }`                     |

---

## Overlays (SvelteKit)

Located in `src/overlays/` - separate package deployed to Vercel.

### Routes

| Route         | Purpose                      |
| ------------- | ---------------------------- |
| `/song-queue` | Now playing / Next up widget |
| `/nix-timer`  | Timer display                |

### Data Fetching Pattern

```typescript
// src/overlays/src/routes/song-queue/+page.server.ts

export const load: PageServerLoad = async ({ fetch, depends }) => {
	const { data }: Data = await fetch("https://twitch-integrations.fly.dev/song-queue").then((res) =>
		res.json(),
	);

	depends("song-queue"); // For invalidation

	return {
		currentlyPlaying: data.at(0),
		nextUp: data.at(1),
	};
};
```

### Client-Side Polling

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { invalidate } from '$app/navigation';

  let active = 'currentlyPlaying';

  onMount(() => {
    const interval = setInterval(() => {
      active = active === 'currentlyPlaying' ? 'nextUp' : 'currentlyPlaying';
      invalidate('song-queue');
    }, 5000);

    return () => clearInterval(interval);
  });
</script>
```

---

## Effect Patterns Reference

### Layer Types

| Type                        | Use Case                 | Example                      |
| --------------------------- | ------------------------ | ---------------------------- |
| `Layer.scoped(Tag, make)`   | Services returning value | `SpotifyApiClient.Live`      |
| `Layer.scopedDiscard(make)` | Background services      | `TwitchService`, subscribers |
| `Layer.effect(Tag, make)`   | Non-scoped services      | Simple wrappers              |

### Resource Management

```typescript
// Acquire/Release pattern
const resource =
	yield *
	Effect.acquireRelease(
		// Acquire: create resource
		Effect.sync(() => new Resource()),
		// Release: cleanup on scope finalization
		(resource) => Effect.sync(() => resource.close()),
	);

// Background fiber tied to scope
yield *
	Effect.forkScoped(
		Effect.forever(
			Effect.gen(function* () {
				// Loop body
			}),
		),
	);
```

### Error Handling

```typescript
// Tagged errors
class MyError extends Data.TaggedError("MyError")<{ cause: unknown }> {}

// Promise-to-Effect with error mapping
const use = <A>(fn: () => Promise<A>) =>
	Effect.tryPromise({
		try: () => fn(),
		catch: (error) => new MyError({ cause: error }),
	});

// Error resilience in subscribers
Effect.forever(handler).pipe(
	Effect.catchAll(() => Effect.void), // Never crash
);
```

### Configuration

```typescript
// Typed config with secrets
const Config = Config.all({
	apiKey: Config.redacted("API_KEY"), // Redacted<string>
	port: Config.number("PORT").pipe(Config.withDefault(3000)),
}).pipe(
	Config.map(({ apiKey, port }) => ({
		apiKey,
		port,
		derivedValue: `http://localhost:${port}`,
	})),
);

// Using secrets
Redacted.value(config.apiKey); // Unwrap for use
```

### Pattern Matching

```typescript
Match.value(input).pipe(
	Match.when({ type: "a" }, (a) => handleA(a)),
	Match.when({ type: "b" }, (b) => handleB(b)),
	Match.orElse(() => handleDefault()),
);
```

---

## Data Flow Diagrams

### Song Request Flow

```
User redeems channel points with Spotify URL
        │
        ▼
┌───────────────────────────────────────────┐
│  channel-redemption-add-for-reward.ts     │
│  pubsub.unsafePublish(SongRequest)        │
└───────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────┐
│            PubSubClient                   │
└───────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────┐
│         SongRequestSubscriber             │
├───────────────────────────────────────────┤
│ 1. Check stream online                    │
│ 2. Extract track ID from URL              │
│ 3. spotify.player.addItemToPlaybackQueue()│
│ 4. spotify.tracks.get() for metadata      │
│ 5. Publish SendTwitchChat (confirmation)  │
│ 6. Update redemption status (FULFILLED)   │
└───────────────────────────────────────────┘
        │                     │
        │ (on error)          │ (on success)
        ▼                     ▼
┌─────────────────┐   ┌─────────────────────┐
│RefundRewardReq  │   │ SendTwitchChat      │
│    Message      │   │    Message          │
└────────┬────────┘   └──────────┬──────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐   ┌─────────────────────┐
│RefundRewardSub  │   │SendTwitchShatSub    │
│ - Cancel redeem │   │ - twitch.chat.send  │
│ - Notify user   │   └─────────────────────┘
└─────────────────┘
```

### !song Command Flow

```
User: !song
    │
    ▼
┌────────────────────────────────────────┐
│    channel-chat-message.ts             │
│    Match.when({ message: "!song" })    │
│    pubsub.unsafePublish(               │
│      CurrentlyPlayingRequest           │
│    )                                   │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│    CurrentlyPlayingRequestSubscriber   │
│    spotify.player.getCurrentlyPlaying()│
│    pubsub.publish(CurrentlyPlaying)    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│    CurrentlyPlayingSubscriber          │
│    Format: "Current song: X by Y"      │
│    pubsub.publish(SendTwitchChat)      │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│    SendTwitchShatSubscriber            │
│    twitch.chat.sendChatMessage()       │
└────────────────────────────────────────┘
    │
    ▼
Chat: "Current song: Song Name by Artist"
```

---

## Configuration

### Environment Variables

| Variable                | Required | Description                      |
| ----------------------- | -------- | -------------------------------- |
| `TWITCH_CLIENT_ID`      | Yes      | Twitch app client ID             |
| `TWITCH_CLIENT_SECRET`  | Yes      | Twitch app secret                |
| `TWITCH_ACCESS_TOKEN`   | Yes      | User access token                |
| `TWITCH_REFRESH_TOKEN`  | No       | Refresh token (recommended)      |
| `SPOTIFY_CLIENT_ID`     | Yes      | Spotify app client ID            |
| `SPOTIFY_CLIENT_SECRET` | Yes      | Spotify app secret               |
| `REDIRECT_SERVER_PORT`  | No       | OAuth port (default: 3939)       |
| `REDIRECT_SERVER_PATH`  | No       | OAuth path (default: "redirect") |

### Hardcoded Values

```typescript
// src/twitch/config.ts
broadcasterId: "209286766";
broadcasterUsername: "dmmulroy";
songRequestRewardId: "c2063c79-a24c-4b17-94f7-c871f2876708";
keyboardRaffleRewardId: "29afa291-244a-47a8-8be8-ded13995e83d";
```

### Token Storage

```
src/do_not_open_on_stream/
└── access-token.json    # Spotify token (gitignored)

src/song-queue/
└── persistence.json     # Queue state

src/nix-timer/
└── persistence.json     # Timer state (local dev)

/data/nix_timer/
└── persistence.json     # Timer state (Fly.io volume)
```

---

## Known Issues & TODOs

### Dead Code

```typescript
// SongAddedToSpotifyQueue is published but never subscribed
// src/pubsub/subscribers/song-request.ts:~line 60
yield * pubsub.publish(Message.SongAddedToSpotifyQueue({ requesterDisplayName, track }));
// ⚠️ SongQueueClient subscribes to this but timing issue prevents it from working
```

### Anti-Patterns

```typescript
// src/spotify/config.ts - unsafe cast
const accessToken: AccessToken = AccessTokenJson as unknown as AccessToken;
// TODO: Use Schema.decode for type safety
```

### Infrastructure

1. **Dockerfile bug:** Duplicate `CMD`, `bun install` never runs
2. **No CI/CD:** Missing `.github/workflows/`
3. **Multi-package without workspaces:** Root, overlays, vendor each have own lockfile

### Suggested Improvements

1. Add Schema validation for config/persistence files
2. Fix SongAddedToSpotifyQueue dead code
3. Add HttpClient from `@effect/platform` instead of raw fetch in Spotify code
4. Add CI pipeline for linting/type checking
5. Consolidate to Bun workspaces

---

## Commands

```bash
# Main service
bun run start

# Get initial Spotify token
bun run get-spotify-access-token

# Overlays (from src/overlays/)
bun run dev      # Vite dev server
bun run build    # Production build
```
