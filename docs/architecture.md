# CF-Twitch Architecture Overview

Twitch stream integration platform on Cloudflare Workers. OAuth tokens, stream lifecycle, song requests, achievements, raffles.

## Tech Stack

| Layer      | Technology                                    |
| ---------- | --------------------------------------------- |
| Runtime    | Cloudflare Workers                            |
| Routing    | Hono                                          |
| State      | Durable Objects + SQLite                      |
| ORM        | Drizzle (`drizzle-orm/durable-sqlite`)        |
| Validation | Zod v4                                        |
| Errors     | `better-result` (Result types, TaggedError)   |
| Workflows  | Cloudflare Workflows + `cf-workflow-rollback` |

## Project Structure

```
cf-twitch/
├── apps/
│   ├── api/                      # Main worker
│   │   ├── src/
│   │   │   ├── index.ts          # Entry, Hono app, DO/WF exports
│   │   │   ├── durable-objects/  # 7 DOs
│   │   │   ├── workflows/        # 3 Workflows
│   │   │   ├── services/         # External API wrappers
│   │   │   ├── routes/           # Hono handlers
│   │   │   └── lib/              # Utilities
│   │   └── wrangler.jsonc
│   └── tail/                     # Error monitoring
└── docs/
```

---

## Durable Objects

Seven singletons manage persistent state.

### Token Management

| DO               | Responsibility                   |
| ---------------- | -------------------------------- |
| `SpotifyTokenDO` | Spotify OAuth, proactive refresh |
| `TwitchTokenDO`  | Twitch OAuth, proactive refresh  |

Both implement `StreamLifecycleHandler`:

- `onStreamOnline()` - Refresh if expired, schedule alarm 5min before expiry
- `onStreamOffline()` - Cancel alarm
- `getValidToken()` - Return cached or refresh
- `alarm()` - Proactive refresh with exponential backoff

### Stream Lifecycle

| DO                  | Responsibility                                      |
| ------------------- | --------------------------------------------------- |
| `StreamLifecycleDO` | Stream state, viewer polling, cascade notifications |

- Tracks `isLive`, `startedAt`, `peakViewerCount`
- Polls viewers every 60s via alarm when live
- Notifies token DOs + WorkflowPoolDO on state change
- Broadcasts WebSocket events to overlay clients

### Song Queue

| DO            | Responsibility                       |
| ------------- | ------------------------------------ |
| `SongQueueDO` | Request queue, Spotify sync, history |

Tables: `pending_requests`, `request_history`, `spotify_queue_snapshot`

Key methods:

- `persistRequest()` - Store request (idempotent via eventId)
- `deleteRequest()` - Rollback support
- `syncFromSpotify()` - Poll Spotify, attribute tracks, reconcile

### Keyboard Raffle

| DO                 | Responsibility             |
| ------------------ | -------------------------- |
| `KeyboardRaffleDO` | Roll tracking, leaderboard |

### Achievements

| DO               | Responsibility                 |
| ---------------- | ------------------------------ |
| `AchievementsDO` | Definitions, progress, unlocks |

Session vs cumulative scope. Session resets on stream online.

### Workflow Pool

| DO               | Responsibility                       |
| ---------------- | ------------------------------------ |
| `WorkflowPoolDO` | Warm workflow instances (3 per type) |

Avoids cold starts. Warm instances wait at `step.waitForEvent("activate")`.

---

## Workflows

Three Cloudflare Workflows with saga pattern (`cf-workflow-rollback`).

### SongRequestWorkflow

Trigger: Channel point redemption

```
Parse Spotify URL → Get track info → Persist in queue
→ Add to Spotify queue → Write history
→ FULFILL (point of no return) → Chat confirmation
```

Rollback before fulfill: Refund points, delete from queue.

### KeyboardRaffleWorkflow

Trigger: Channel point redemption

```
Generate winning number → Generate roll → Calculate distance
→ Record in DO → Fulfill → Chat message
```

### ChatCommandWorkflow

Trigger: `!song` or `!queue` chat command

```
Parse command → Fetch from SongQueueDO → Chat response
```

---

## Services

Plain classes wrapping external APIs. Instantiated directly, not service bindings.

### SpotifyService

- `exchangeToken()` - OAuth
- `getTrack()`, `getCurrentlyPlaying()`, `getQueue()`
- `addToQueue()`, `skipTrack()`

### TwitchService

- `exchangeToken()` - OAuth
- `getStreamInfo()` - Viewer polling
- `createEventSubSubscription()`, `deleteEventSubSubscription()`
- `sendChatMessage()`, `updateRedemptionStatus()`

Token strategy:

- User ops: `TwitchTokenDO.getValidToken()`
- EventSub webhooks: App access token (client credentials)

---

## Routes

| Mount        | Purpose                         |
| ------------ | ------------------------------- |
| `/oauth`     | Spotify/Twitch OAuth flows      |
| `/eventsub`  | EventSub subscription mgmt      |
| `/webhooks`  | Twitch EventSub receiver        |
| `/api`       | Public API (now-playing, queue) |
| `/api/stats` | Analytics                       |
| `/overlay`   | HTML overlay for OBS            |
| `/health`    | Health check                    |

### Webhook Handler

Receives from Twitch EventSub:

- `stream.online/offline` → StreamLifecycleDO
- `channel.channel_points_custom_reward_redemption.add` → Workflow
- `channel.chat.message` → ChatCommandWorkflow

HMAC-SHA256 signature + timestamp verification.

---

## Data Flows

### Song Request

```
Twitch EventSub (redemption)
  → /webhooks (verify signature)
  → triggerWarmWorkflow()
  → SongRequestWorkflow
    → SpotifyService.getTrack() → SpotifyTokenDO
    → SongQueueDO.persistRequest()
    → SpotifyService.addToQueue()
    → TwitchService.updateRedemptionStatus() → TwitchTokenDO
    → TwitchService.sendChatMessage()
```

### Stream Lifecycle

```
Twitch EventSub (stream.online)
  → /webhooks
  → StreamLifecycleDO.onStreamOnline()
    → SpotifyTokenDO.onStreamOnline() (parallel)
    → TwitchTokenDO.onStreamOnline()
    → WorkflowPoolDO.onStreamOnline()
    → Schedule viewer polling alarm
```

### Token Refresh

```
TokenDO.getValidToken()
  → Cache valid? Return
  → Expired? refreshToken() → setTokens()
  → Proactive: alarm 5min before expiry → refresh
  → Failure: exponential backoff retry
```

---

## Key Patterns

### Error Handling

All errors extend `TaggedError`:

```typescript
class SpotifyTrackNotFoundError extends TaggedError("SpotifyTrackNotFoundError")<{
	trackId: string;
	message: string;
}>() {}
```

- All fallible ops return `Result<T, E>`
- Type narrow via `MyError.is(error)` not `instanceof`
- "Not found" returns typed error, not `null`

### DO RPC

```typescript
const stub = getStub("SONG_QUEUE_DO");
const result = await stub.persistRequest({...}); // Result<T, E | DurableObjectError>

// DO export wrapped for serialization
export const SongQueueDO = withResultSerialization(SongQueueDOBase);
```

### Warm Workflow Pool

```typescript
const params = await waitForActivation(step, event.payload);

await triggerWarmWorkflow({
	workflow: env.SONG_REQUEST_WF,
	workflowType: "song-request",
	instanceId: workflowId,
	params: redemption,
});
```

### Saga Rollback

```typescript
const step = withRollback(workflowStep);

await step.doWithRollback("persist-request", {
	run: async () => {
		/* work */ return eventId;
	},
	undo: async (_err, eventId) => {
		/* compensate */
	},
});

await step.rollbackAll(error); // on failure
```

---

## External Integrations

### Twitch

- OAuth: User tokens (chat/redemptions), app tokens (EventSub)
- EventSub: Webhooks for stream/redemption/chat
- Helix API: Streams, redemptions, chat

### Spotify

- OAuth: User tokens for playback
- Web API: Tracks, queue, currently playing, skip
- Internal APIs: Connect state (undocumented)

---

## Monitoring

- Tail Worker (`apps/tail/`): Exceptions → Analytics Engine
- Full trace/log sampling in `wrangler.jsonc`
- Analytics Engine: Song request + raffle metrics

---

## System Diagram

```
                           ┌─────────────────────────────────────────────────────┐
                           │                  Cloudflare Worker                   │
                           │                                                      │
  Twitch EventSub ────────►│  /webhooks ──────► StreamLifecycleDO                │
  (stream.online/offline)  │       │                    │                         │
                           │       │           ┌───────┴───────┐                  │
                           │       │           ▼               ▼                  │
  Twitch EventSub ────────►│       │    SpotifyTokenDO   TwitchTokenDO           │
  (redemption)             │       │           │               │                  │
                           │       ▼           ▼               ▼                  │
                           │  WorkflowPoolDO                                      │
                           │       │                                              │
                           │       ▼                                              │
                           │  ┌─────────────────────────────────────────┐        │
                           │  │            Workflows                     │        │
                           │  │  ┌──────────────┐  ┌─────────────────┐  │        │
                           │  │  │SongRequestWF │  │KeyboardRaffleWF │  │        │
                           │  │  └──────────────┘  └─────────────────┘  │        │
                           │  │         │                    │          │        │
                           │  │         ▼                    ▼          │        │
                           │  │    SongQueueDO        KeyboardRaffleDO  │        │
                           │  └─────────────────────────────────────────┘        │
                           │                                                      │
                           │  ┌─────────────────────────────────────────┐        │
                           │  │            Services                      │        │
                           │  │  ┌──────────────┐  ┌─────────────────┐  │        │
                           │  │  │SpotifyService│  │  TwitchService  │  │        │
                           │  │  └──────────────┘  └─────────────────┘  │        │
                           │  └──────────┬─────────────────┬────────────┘        │
                           └─────────────┼─────────────────┼──────────────────────┘
                                         │                 │
                                         ▼                 ▼
                                   Spotify API       Twitch Helix API
```
