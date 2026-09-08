# Architecture

## Engineering conventions

Use Effect services, Layers, Schema, and workflows; Durable Objects expose versioned HTTP APIs. Application dependencies stay within the app or flow from packages into apps. Framework bindings, SQL rows, and provider representations stay private to their owning adapters.

Service modules own their explicit interface, contextual tag, expected errors, constructor, and dependency-preserving Layer. Runtime consumers import Layers and yield services. Keep dependency requirements visible until the composition root selects implementations. Preserve tagged failure distinctions and interruption when translating boundary errors.

Use owner-provided types, narrowing, and schema refinements. Ordinary casts, `any`, non-null assertions, and unchecked parser failures require redesign; unavoidable boundary exceptions need concrete evidence and a safety comment. Test through real services and interfaces rather than module replacement. Exported symbols have concise JSDoc and searchable domain-qualified names.

Root `vite.config.ts` owns lint policy, including the cyclomatic complexity ceiling. Refactor by cohesive responsibility: a helper earns its place by reducing reasoning burden while retaining precise input/error types. A smaller branch count alone does not justify extraction. Read manifests and pinned library source before selecting APIs; examples in other projects can lag this repository.

## Ownership

`apps/api` is the deployable application. `packages/contracts` contains portable Effect schemas and domain values; explicit subpath exports keep imports searchable. `packages/shared-infrastructure` owns stage parsing, local test identities, and the actual Analytics Engine binding descriptor. Packages never import the app.

Each capability owns its public service, expected errors, persistence, and transport. A service tag has one application-facing interface whether it is backed by local SQL or a generated Durable Object HTTP client. HTTP payloads, provider JSON, stored JSON, and SQL projections are decoded at their owner boundary. Shared contracts retain branded identities and use Effect Option for ordinary absence.

### Provenance

| Established input evidence                                                   | Required handling                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Raw SQL rows, native storage, or an untyped body                             | Parse unknown at the owning boundary into the strongest meaningful type. A SQL generic annotation is not validation. |
| A known encoded representation, such as a stage string or JSON column string | Use a typed decoder. The representation is known; its contents still need validation.                                |
| An already-parsed domain value                                               | Pass the value through with its existing type.                                                                       |
| A computed constrained value or patched state                                | Establish the additional invariants with the owning typed constructor or refinement.                                 |

Application parser APIs expose needed inputs rather than library parse options; use a private codec behind a narrow unary wrapper unless callers need additional domain input. Keep concrete input types through transformations, without encoding to JSON merely to regain a type afterward.

For a parsing change, identify the producer, already-established invariants, remaining invariants, and validation removed, retained, or moved. Separate reduced runtime work from a typed-decoder substitution. Persisted cross-field facts still need runtime evidence even when individual fields have valid types.

Storage provenance selects the codec: current tables use current codecs; identified legacy sources use explicit compatibility translation. Commit to the representation indicated by its evidence instead of falling through to a weaker schema after a parse failure.

The service implementation is selected through a Layer. `*LayerWithoutDependencies` leaves application dependencies visible for composition; the ready Layer selects production dependencies. A test constructs the graph from controlled dependencies upward rather than overriding a fully built production graph.

## Composition and lifetime

```text
Alchemy Stack
  └─ TwitchApiWorker
       ├─ public HTTP handlers → capability services → DO HTTP clients
       └─ thirteen registered Durable Object servers
            └─ application services → SQLite/native storage + outgoing capabilities
```

Alchemy constructors have two phases:

1. **Outer initialization** runs during planning and runtime cold start. It registers bindings and captures stable application services. It must not query SQL, migrate tables, or touch storage.
2. **Durable runtime initialization** acquires the DO's real state and SQLite client, validates legacy authority, runs migrations, and reconstructs alarms before returning handlers.

Captured outer services are bridged into inner Layers using `Layer.succeed`. The app never moves an infrastructure-backed Layer into the runtime phase merely to satisfy a type error.

Worker routing and DO client acquisition use `makeExecutionMemo`. Generated clients are created inside suspended Effects, in the current invocation's scope. Namespace stubs, HTTP clients, SQL handles, and native cache operations must not escape their owning lifetime. The Worker cache opens lazily during I/O, not during planning.

[Runtime Layer type tests](../apps/api/src/runtime/twitch-layer-types.test.ts) check that storage and invocation scopes do not leak into planning requirements. The [verification guide](verification.md) identifies runtime evidence beyond this type gate.

## Durable authorities

| Physical class                              | Object key                      | Authority                                                     |
| ------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `SpotifyTokenDO`, `TwitchTokenDO`           | `spotify-token`, `twitch-token` | Credentials, lifecycle, refresh deadlines                     |
| `OAuthStateDO`                              | Random authorization state      | Provider/redirect-bound native one-use state and alarm        |
| `SongQueueDO`                               | `song-queue`                    | Pending requests, occurrence snapshots, request history       |
| `KeyboardRaffleDO`                          | `keyboard-raffle`               | Immutable rolls and compensation tombstones                   |
| `AchievementsDO`                            | `achievements`                  | Progress, unlocks, stream watermark, inbox/outbox             |
| `CommandsDO`                                | `commands`                      | Definitions, aliases, values, counters, mutation receipts     |
| `EventBusDO`                                | `event-bus`                     | Delivery receipts, pending retries, dead letters              |
| `StreamLifecycleDO`                         | `stream-lifecycle`              | Tagged stream state, transition checkpoints, viewer snapshots |
| `SongRequestSagaDO`, `KeyboardRaffleSagaDO` | Redemption ID                   | Workflow journal, checkpoints, compensation evidence          |
| `RaidShoutoutSagaDO`                        | EventSub message ID             | Raid workflow and mutation uncertainty                        |
| `EventSubWebhookDO`                         | EventSub message ID             | Validated receipt, leased dispatch, chat checkpoint           |

A physical class name preserves identity, not serialized-format compatibility. Historical Agent JSON, Agent schedules, native storage, and SQL are separate persistence planes. Importers preserve original tables and fail closed on invalid authority. The [cutover gate](production-cutover.md) covers representations that cannot safely be imported automatically.

## Recovery rules

- EventSub authenticates exact bytes before persistence. Receipt identity and content must agree on redelivery.
- Known-key undo intent commits before remote persistence. A lost success response must not allow a refund while leaving a pending request or raffle roll behind. Compensation tombstones also prevent delayed writes from resurrecting canceled work.
- Spotify queue mutation, Twitch chat, and shoutout delivery have explicit uncertain outcomes. A timeout is not evidence that a mutation did not happen.
- Fulfilled redemption is the point of no return. Required post-commit publication failure never triggers a refund.
- Inbox deduplication, state changes, and outbox intents commit transactionally. Restart repairs schedules and turns interrupted `sending` states into `uncertain`, not `pending`.
- Stream transitions preserve source-time ordering and four resumable side-effect checkpoints. An opaque legacy schedule ID is not a timestamp.

## Observability and configuration

`TwitchConfiguration` reads Effect Config during outer initialization, allowing Alchemy to discover bindings. Secrets remain Redacted until final I/O. Configuration failures intentionally omit raw values and parser causes.

The stock Effect HTTP tracers collect full URLs, query values, and headers, including OAuth redirect Locations. `twitchHttpTelemetrySafetyLayer` disables that automatic collection for both HTTP servers and clients. It is merged into the **outer exported Worker Layer**, because Alchemy's native HTTP adapter wraps the application handler. Disabling tracing only inside `fetch` is too late.

Public HTTP uses an allowlisted server span with method, path, query keys, status, and server-owned request identity. `x-trace-id` comes from that actual span. Named application spans remain enabled. Generated handler groups are built with empty error reporters because the pinned `HttpApiBuilder` captures construction context and reports before outer middleware. The outer HTTP boundary retains configured reporters and reports a fixed-message failure with safe classification/correlation and a Redacted original cause. The HTTP server span's failed exits omit raw request URLs and defect text; interruption remains visible. Durable events carry explicit correlation IDs. Analytics Engine delivery is best effort; business correctness never depends on successful metric export.

## Pinned-library constraints

Inspect the installed Effect/Alchemy source when changing dependencies. These constraints explain behavior that package versions alone cannot show:

- Use `Schema.TaggedError<Self>()`, not the older remembered `TaggedErrorClass` API.
- Worker/DO HTTP handler contracts are type aliases. Explicit `.make<never>` may be necessary for dependency-free DO constructors to avoid state-requirement inference leaks.
- `HttpRouter.toHttpEffect` requires an invocation Scope; outer Worker initialization does not provide it.
- Use `compatibility: { date, flags }` for Worker properties.
- Worker compatibility is pinned to `2026-09-08`. Keep scenario Workers aligned with the application Worker. The workspace overrides Alchemy's older workerd pin with `1.20260908.1` so local tests support this date. With unpatched Alchemy, the historical `2026-01-13` date fails native startup with `TypeError: t.once is not a function`; updating compatibility resolves it without dependency patches.
