# Vision

CF Twitch is a Cloudflare-hosted Twitch stream integration for a broadcaster and the viewers participating in that stream. It should make channel-point redemptions, chat commands, stream events, Spotify playback, raffles, achievements, and stream overlays feel like one dependable system while preserving prompt viewer feedback, replay-safe side effects, durable state, and low operational burden. It does not aim to become a multi-tenant bot platform or a complete Twitch or Spotify client.

## What Fits

- Bounded fixes and improvements to the existing stream interactions: Song Requests, Chat Commands, Keyboard Raffles, Achievements, Stream Lifecycle, raid shoutouts, viewer statistics, and the Now Playing overlay.
- New commands, achievement rules, or reward behavior that reuse the existing domain models and do not introduce a new provider, trust boundary, or orchestration model.
- Reliability work that prevents dropped, duplicated, or permanently stuck viewer actions, including retry, compensation, idempotency, dead-letter recovery, token refresh, and stream-state reconciliation.
- Operator-facing diagnostics and recovery controls that are authenticated, narrowly scoped, and support a concrete production failure mode.
- Performance, observability, test, and documentation improvements that keep the current product behavior and Cloudflare deployment model intact.
- Incremental Twitch or Spotify API support required by an accepted stream interaction; provider coverage is driven by user-visible flows rather than API completeness.

## Where Work Belongs

- Hono routes own HTTP, OAuth, EventSub verification, request parsing, authentication, and response mapping. They should route accepted work rather than absorb durable business orchestration.
- Service classes own Twitch and Spotify API contracts, authentication use, and provider error translation.
- Durable Objects own state with a clear authority: Agent state for current coordination state, and SQLite/Drizzle for durable history, queryable records, and due-work evidence.
- Sagas own multi-step viewer interactions that need replay, retry, or compensation. Successful steps must remain safe to replay, and failures must preserve the existing fulfill/refund boundary.
- EventBusDO owns asynchronous domain-event delivery and recovery. Consumers such as AchievementsDO own the domain rules triggered by those events; publishers should not regain that logic.
- Shared modules should expose narrow domain or infrastructure capabilities. Do not introduce a generic workflow, plugin, or provider framework until more than one accepted use needs it.

## Discuss First

- A new interaction category, public API surface, overlay, provider, or viewer-data use that extends beyond the existing Twitch/Spotify stream loop.
- Multi-broadcaster support, tenant isolation, self-service setup, or any change that turns a per-deployment integration into a hosted product.
- A new dependency, Cloudflare primitive, background process, Durable Object class, persistent schema, or source-of-truth split.
- Changes to EventSub acknowledgement, saga replay or compensation, EventBus delivery, OAuth/token handling, or public/admin authentication.
- Breaking RPC, HTTP, command, persisted-data, or deployment behavior, including migrations that require compatibility or rollout sequencing.
- Broad refactors, generalized frameworks, or test seams that add ongoing concepts without simplifying a proven production boundary.
- Provider-specific behavior that cannot be validated against Twitch or Spotify when live behavior is the point of the change.

## Merge Bar

- Exercise the changed behavior at its public boundary. Add or update worker-pool tests for routes and Durable Objects; use external HTTP mocks only at Twitch and Spotify boundaries rather than adding test-only production hooks.
- Run the repository checks, including formatting, linting, type checking, and the affected API tests.
- For retries, redemptions, random rolls, event delivery, or migrations, show that duplicate delivery and reactivation do not repeat successful side effects or lose authoritative state.
- For Twitch or Spotify behavior, provide live-provider proof when practical. If credentials, account state, or provider access block it, name the exact missing validation and provide the strongest local evidence available.
- Treat external input and persisted JSON as untrusted boundaries, and do not expose tokens, webhook secrets, raw sensitive payloads, or arbitrary causes in logs or responses.
- Document user-visible command/API changes and any operator action required for deployment, migration, recovery, or rollback.

## Not Now

- A general-purpose Twitch bot framework, plugin marketplace, or dynamic provider system.
- Multi-tenant hosting, arbitrary broadcaster onboarding, billing, or account administration.
- Broad Twitch or Spotify API parity unrelated to an accepted viewer or operator flow.
- AI or vector-search infrastructure without a concrete need in an established stream interaction.
- Replacing the Worker, Durable Object, Agent scheduling, saga, or EventBus model solely to adopt a different platform primitive.

These are current guardrails. Work in a “Not Now” category can proceed only after the project direction and the resulting operational burden are explicitly reconsidered.
