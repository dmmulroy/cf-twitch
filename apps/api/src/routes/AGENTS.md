# routes/

Hono route handlers - each file exports a typed router mounted in `index.ts`.

## Routes

| File | Mount | Purpose |
|------|-------|---------|
| `oauth.ts` | `/oauth` | Spotify/Twitch OAuth authorize + callback |
| `webhooks.ts` | `/webhooks` | EventSub receiver, signature verify, chat commands |
| `api.ts` | `/api` | REST: now-playing, queue, achievements |
| `overlay.ts` | `/overlay` | OBS HTML overlays (transparent bg) |
| `stats.ts` | `/api/stats` | Cached analytics (60s edge cache) |
| `eventsub-setup.ts` | `/eventsub` | Subscription CRUD (one-time setup) |

## Patterns

```typescript
// Router creation - always typed bindings
const router = new Hono<{ Bindings: Env }>();

// Request data
c.req.param("id")           // URL params
c.req.query("limit")        // Query string
c.req.header("x-custom")    // Headers

// Responses
c.json({ data })            // JSON (default 200)
c.json({ error }, 400)      // JSON with status
c.html(htmlContent)         // HTML response
c.text(challenge, 200)      // Plain text
c.redirect(url, 302)        // Redirect

// DO calls - always via getStub()
const stub = getStub("SONG_QUEUE_DO");
const result = await stub.getQueue(10);
if (result.status === "error") {
  return c.json({ error: result.error.message }, 500);
}
return c.json(result.value);
```

## Middleware

| Pattern | Location | Auth |
|---------|----------|------|
| `/*/authorize` | `oauth.ts:45` | `X-Setup-Secret` or `?setup_secret=` |
| EventSub verify | `webhooks.ts:208` | HMAC-SHA256 signature + timestamp |

## Validation

- **Zod at boundaries**: `Schema.safeParse()` → 400 on failure
- **Query params**: `z.coerce.number()` for type conversion
- **Headers**: Full schema for EventSub (`EventSubHeadersSchema`)
