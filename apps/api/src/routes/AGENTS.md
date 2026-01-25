# Routes

Hono route handlers. See root AGENTS.md for conventions.

## Files

| File                | Mount Point  | Purpose                     |
| ------------------- | ------------ | --------------------------- |
| `oauth.ts`          | `/oauth`     | Spotify/Twitch OAuth flows  |
| `eventsub-setup.ts` | `/eventsub`  | EventSub subscription setup |
| `webhooks.ts`       | `/webhooks`  | Twitch EventSub callbacks   |
| `api.ts`            | `/api`       | REST API endpoints          |
| `stats.ts`          | `/api/stats` | Stats/analytics endpoints   |
| `overlay.ts`        | `/overlay`   | Stream overlay endpoints    |

## OAuth Flow

`oauth.ts` handles OAuth2 authorization code flow:

1. `/oauth/spotify` - Redirect to Spotify authorize
2. `/oauth/spotify/callback` - Exchange code, store tokens in SpotifyTokenDO
3. `/oauth/twitch` - Redirect to Twitch authorize
4. `/oauth/twitch/callback` - Exchange code, store tokens in TwitchTokenDO

## Webhook Handling

`webhooks.ts` receives Twitch EventSub callbacks:

1. Verify signature via `Twitch-Eventsub-Message-Signature` header
2. Handle challenge requests (subscription verification)
3. Dispatch to StreamLifecycleDO on stream.online/offline events
4. Dispatch to workflows for channel point redemptions

**Pending refactor (AI TODO):**

- Extract header validation to Hono middleware (line 165)
- Split into smaller handler functions (line 274)

## Adding New Route

1. Create `routes/my-route.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../index";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ ok: true }));

export default app;
```

2. Mount in `index.ts`:

```typescript
import myRoute from "./routes/my-route";
app.route("/my-route", myRoute);
```
