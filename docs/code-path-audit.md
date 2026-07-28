# Application code-path audit

- Audited base commit: `82250fe`
- Audited source state: uncommitted corrective composition-root refactor in the current worktree
- Audited on: `2026-07-27`
- Runtime entrypoint: `apps/api/src/index.ts`
- Wrangler configuration: `apps/api/wrangler.jsonc`

## Verification

- `pnpm --filter cf-twitch-api typecheck`: passed
- `pnpm --filter cf-twitch-api architecture`: passed
- `pnpm --filter cf-twitch-api test`: passed
- `git diff --check`: passed

Test file and assertion counts are intentionally omitted because they become stale without changing application behavior.

## Scope

This audit covers production TypeScript reachable from the Worker entrypoint and Durable Object exports. It focuses on runtime topology, dependency acquisition, RPC parsing, correlation, and provider boundaries. Generated migrations and test fixtures are considered only where they verify a production seam.

## Runtime topology

```text
Internet / Twitch / OBS
  -> Worker.fetch (`src/index.ts`)
     -> parse Worker configuration once
     -> establish request and trace correlation
     -> construct Cloudflare and provider adapters
     -> construct exact Hono route groups
     -> route handler
        -> application-owned capability
        -> Cloudflare adapter or provider service
           -> Durable Object RPC / Cache API / provider HTTP
           -> parse boundary payload
        -> HTTP projection

Twitch EventSub
  -> signature-verified HTTP adapter
  -> durable EventSub receipt acceptance keyed by message ID
  -> EventSubWebhookDO detached processing
     -> restore persisted correlation
     -> Stream Lifecycle / saga starter / Chat Command capabilities

Agent schedule
  -> Durable Object callback
  -> persisted retry or reconciliation state
  -> exact constructor-owned dependencies
  -> schedule next callback or reach a terminal state
```

## Worker composition root

`src/index.ts` is the only Worker HTTP composition root. For each invocation it:

1. creates request and trace identifiers;
2. parses raw Worker bindings through `parseWorkerConfiguration()`;
3. constructs provider token adapters and Spotify/Twitch services;
4. constructs Durable Object adapters for Song Queue, Raffle Statistics, Stream Lifecycle, Achievements, EventSub receipts, Event Bus administration, OAuth state, and Chat Commands;
5. constructs edge caching with `ExecutionContext.waitUntil()` hidden inside the cache adapter;
6. passes exact dependencies to Hono route factories.

HTTP route modules under `src/adapters/http/` do not import generated `Env`, inspect `context.env`, acquire Durable Object stubs, or construct provider services.

## HTTP serving surfaces

Route factories own these groups:

- `create-now-playing-routes.ts`: Now Playing.
- `create-api-routes.ts`: queue, Song Request history, Achievement projections, Stream Lifecycle/debug reconciliation.
- `create-stats-routes.ts`: cached Song Request and Keyboard Raffle statistics.
- `create-oauth-routes.ts`: Spotify/Twitch authorization and state-validated callbacks.
- `create-eventsub-routes.ts`: authenticated EventSub administration.
- `create-eventsub-webhook-routes.ts`: bounded-body, constant-time signature verification and durable receipt acceptance.
- `create-admin-routes.ts`: authenticated Event Bus, Achievement, Chat Command, and cross-domain diagnostics.
- `create-overlay-routes.ts`: static overlay document.
- `worker-http-app.ts`: common request logging/correlation, route mounting, health, and response correlation headers.

All administrator secrets remain redacted until the final authentication comparison.

## Durable Object composition roots

Each Durable Object constructor translates its `Env` into the exact dependencies used by inner behavior:

- `SongQueueDO`: Spotify service and token-backed playback access.
- `EventSubWebhookDO`: parsed reward routing, Twitch service, state readers, durable work starters, Chat Command engine dependencies, metrics, clock, and logging.
- `SongRequestSagaDO`: Song Queue, Spotify/Twitch services, and Domain Event publication.
- `KeyboardRaffleSagaDO`: Roll store, Twitch service, Domain Event publication, metrics, and randomness.
- `RaidShoutoutSagaDO`: Twitch service.
- `StreamLifecycleDO`: provider-token lifecycle, Domain Event publication, Twitch stream reads, and analytics.
- `AchievementsDO`: Twitch token/service dependencies and analytics.
- `EventBusDO`: Achievement Domain Event handler.
- shared `SagaHost`: captures its Analytics Engine binding during construction rather than consulting inherited ambient environment state later.

No production module imports or calls an ambient `getStub()` service locator. The legacy global locator and its proxy/deserialization stack have been removed.

## Application-owned capabilities

Application and HTTP code depend on capabilities under `src/capabilities/`, including:

- Song Queue reads, writes, and statistics;
- Keyboard Raffle statistics and Roll persistence;
- Stream Lifecycle and Achievement state;
- Chat Command catalog, counters, and administration;
- Event Bus publication, handling, and administration;
- EventSub receipt acceptance and durable work starters;
- OAuth authorization state;
- provider access-token lifecycle;
- tracing and edge response caching.

Capability methods return application-owned values and typed errors. They do not expose Durable Object stubs, namespace bindings, provider wire objects, or `unknown` payloads.

## RPC boundary validation

Raw `unknown` is retained only where data first crosses a boundary:

- generated/raw Durable Object stub return values;
- RPC envelope and success/error parser inputs;
- Cache API deserialization;
- provider response JSON;
- public Durable Object RPC input before schema parsing.

Cloudflare adapters then:

1. acquire and initialize the correct named Agent stub;
2. invoke one method-specific RPC;
3. validate the serialized Result envelope;
4. parse the selected success or error payload with a method-specific schema;
5. translate transport, protocol, and remote failures into application errors;
6. return only parsed application-owned values.

The architecture check rejects generated `Env` outside runtime owners, Hono outside HTTP owners, route binding lookups, ambient `getStub` imports, and Cloudflare binding names in application code.

## Correlation and observability

Worker requests receive server-owned request and trace identifiers. The request logger and tracer carry those identifiers through HTTP and adapter spans. EventSub acceptance persists correlation before detached Durable Object processing; `EventSubWebhookDO` restores it for downstream logs, Chat Command processing, and saga starts.

Sensitive configuration and tokens use `RedactedValue`. Logs record stable operation names, error tags, and safe identifiers rather than raw authorization values or provider payloads.

## Finding: global Durable Object service locator

Status: Resolved in the audited worktree

Evidence:

- `src/index.ts` explicitly constructs namespace-backed adapters.
- `src/adapters/http/create-admin-routes.ts` replaced the final route-level stub lookups.
- `src/adapters/cloudflare/durable-object-chat-commands.ts` replaced the Chat Command catalog locator.
- `src/lib/durable-objects.ts` now owns only method-level clone-safe Result serialization.
- `rg 'getStub\(|globalEnv|this\.env' apps/api/src` has no production matches.
- `tools/architecture/check-cloudflare-composition.ts` has no migration allowlist for the locator.

Regression evidence:

- Worker entrypoint integration tests.
- Admin Chat Command route integration tests.
- Durable Object adapter and Agent initialization tests.
- architecture check.

## Finding: application capabilities returning unparsed RPC data

Status: Resolved in the audited worktree

Evidence:

- application/domain schemas live under `src/domain/`;
- public capability signatures under `src/capabilities/` contain no `unknown` results;
- Cloudflare adapters own method-specific RPC envelope, value, and error parsing;
- malformed payload behavior is covered by RPC and adapter tests.

## Finding: module-level route composition and route binding lookup

Status: Resolved in the audited worktree

Evidence:

- all production route groups are factories under `src/adapters/http/`;
- `worker-http-app.ts` receives precomposed OAuth, EventSub, webhook, overlay, and Admin groups;
- route factories receive exact capability dependencies;
- the old singleton modules under `src/routes/` are deleted;
- architecture enforcement rejects `.env` access in HTTP adapters.

## Known limitations

- Provider modules still combine several cohesive Spotify or Twitch operations behind one service class. Their constructors are dependency-injected and binding-free, but further splitting is a maintainability improvement rather than a composition-root blocker.
- The generic `SongQueueClient` remains as a boundary-testing facade around an injected RPC handle acquisition. It has no ambient namespace acquisition and is not used by production HTTP or application composition.
- Durable Object classes necessarily receive generated `Env` from Cloudflare. Their constructors are the permitted runtime boundary; inner application behavior receives exact dependencies.
