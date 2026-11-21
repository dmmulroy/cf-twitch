# Architecture

## Engineering conventions

The project traits in [`.agents/traits/`](../.agents/traits/) are authoritative coding rules. When this document, older code, or another guide conflicts with a trait, the trait wins and the conflicting text is corrected. Check changed files with the `traits` MCP `check_traits` tool (see [AGENTS.md](../AGENTS.md#traits)); its findings are per 200-line chunk and need review against the trait text. This section summarizes how the traits apply here; the trait files hold the exact requirements.

Use Effect services, Layers, Schema, and workflows; Durable Objects expose versioned HTTP APIs. Application dependencies stay within the app or flow from packages into apps. Framework bindings, SQL rows, and provider representations stay private to their owning adapters.

### Service modules

Each service whose implementation the application builds lives in a file named for its capability and declares, in this order (`effect-service-module-layout`):

1. `I<Capability>`: the service interface.
2. The `Context.Service` class, named for the capability without `Tag`.
3. `make<Capability>`: the constructor Effect.
4. `<capability>LayerWithoutDependencies`: the Layer that leaves application dependencies in its requirement channel.
5. `<capability>Layer`: the production Layer. With no production dependencies it is `<capability>Layer = <capability>LayerWithoutDependencies`.
6. `<capability>TestLayer`: a complete, behaviorally honest in-memory or controlled implementation that crosses the same interface, exported from the same file. It provides every application service it depends on with that service's own `…TestLayer` and leaves only platform services (`HttpClient`, `SqlClient`, `Digest`, `SecureRandom`) and the token Durable Object identity for the test to select. [Runtime Layer type tests](../apps/api/src/runtime/twitch-layer-types.test.ts) enforce this. A test that needs controlled or failing dependencies builds from `<capability>LayerWithoutDependencies` instead.

Every exported symbol in the module includes the capability name. Services that are an Alchemy or Workers-runtime binding, Alchemy resource declarations, Workers, and Durable Object classes are exempt. A test control surface that a test Layer also provides, such as `TwitchAnalyticsRecording` beside `twitchAnalyticsTestLayer`, lives in the same file.

Runtime consumers import Layers and yield services. A Layer that depends on a service yields it while building and keeps it required until a composition root selects an implementation with `Layer.provide`; modules export Layer values, not factories that take services as arguments (`layer-dependencies-stay-required`).

### Typed errors and messages

Expected failures are `Schema.TaggedError` classes (`typed-error-context`) with:

- `operation`: a `Schema.Literals` union naming the operation that failed.
- `reason`: a `Schema.Literals` union classifying the cause.
- The safe domain identifiers the failing code knows, as `Option` when they may be absent, plus further context when it applies (field violations, retryability, a safe cause).
- A `message` getter whose text begins with a literal description, names the operation and reason, and ends with one way forward: correct the input and retry, retry when safe, inspect or reconcile an uncertain resource, or contact support with the request ID.

Messages are calm and blame no one; retry advice and reassurance claim only what the operation's idempotency proves (`truthful-retry-and-reassurance`). Text that callers read uses domain words, not storage or runtime mechanics (`durable-public-vocabulary`). Defect messages passed to `Effect.die` follow the same wording rules.

Translate expected failures by tag with `Effect.catchTag`/`Effect.catchTags`, passing correct application errors through unchanged and leaving unknown tags in the error channel. `Effect.mapError` is for channels with one meaning; `instanceof` is for non-Effect errors where they enter Effect (`explicit-tagged-error-translation`). Preserve interruption when translating.

The HTTP feature owns the public error envelope: stable `code`, operation-specific `message`, variant-specific `details`, `requestId`, and a truthful `retryable`, with statuses chosen by what the failure means to the caller. Capabilities expose typed errors with `operation` and `reason`; they do not render HTTP responses.

### Types, absence, and parsing

Use owner-provided types, narrowing, and schema refinements. Ordinary casts, `any`, non-null assertions, and unchecked parser failures require redesign; a single unavoidable boundary assertion needs concrete evidence and a safety comment (`type-assertions-at-proven-boundaries`). Preserve the strongest known type through every boundary and intermediate step (`preserve-established-types`).

Inside the application, optional values are `Option.Option<A>`. Nullable or optional external input is decoded into `Option` at the boundary and encoded back only where an external contract requires `null`, `undefined`, or an omitted key (`option-for-optional-values`). Parsing rules follow the [provenance table](#provenance).

### Documentation comments

Every exported declaration, public class member, and interface or service member has its own JSDoc; exported object and schema fields are documented when their meaning goes beyond name and type (`jsdoc-on-exports`). The summary is one paragraph: functions and methods start with a present-tense verb (`Parses`, `Returns`), values, types, Layers, and fields with a noun phrase (`Layer that`, `Schema for`) (`jsdoc-summary-paragraph`). Optional sections follow in the order **When to use**, **Details**, **Gotchas**, **Example**, then tags in the order `@deprecated`, `@template`, `@param`, `@returns`, `@throws`, `@default`, `@see` (`jsdoc-effect-layout`). `@returns` names the errors an Effect or Result fails with and when; `@throws` names thrown errors, rejections, and defects anywhere in the call stack (`jsdoc-error-documentation`).

### Tests

Tests exercise behavior through public interfaces with real or behaviorally faithful implementations, such as SQLite, `TestClock`, `<capability>TestLayer`s, and controlled providers, and each test name states the behavior it proves (`faithful-verification`). Schema tests cover behavior the application owns, such as transformations, custom filters, compatibility contracts, round trips, and regressions, not library mechanics a declaration already specifies (`schema-tests-cover-owned-behavior`).

### Lint and refactoring

Root `vite.config.ts` owns lint policy, including the cyclomatic complexity ceiling. Refactor by cohesive responsibility: a helper earns its place by reducing reasoning burden while retaining precise input/error types (`cohesive-extraction`). A smaller branch count alone does not justify extraction. Read manifests and pinned library source before selecting APIs; examples in other projects can lag this repository.

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

The service implementation is selected through a Layer. `*LayerWithoutDependencies` leaves application dependencies visible for composition; the ready Layer selects production dependencies; `*TestLayer` supplies the controlled implementation. A test constructs the graph from controlled dependencies upward rather than overriding a fully built production graph.

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

Captured outer services are bridged into inner Layers using `Layer.succeed`. The app never moves an infrastructure-backed Layer into the runtime phase merely to satisfy a type error. Cryptographic operations use the Effect 4.1 `effect/crypto` services: `SecureRandom` for UUIDs and raffle bytes, `Digest` for SHA-256. Outer roots select `NodeCrypto.layerSecureRandom`/`NodeCrypto.layerDigest`, and Stream/Raffle/Workflow servers capture and bridge those services rather than choosing a platform implementation inside the Durable Object runtime. Alchemy beta.87 classifies both as Worker platform services (its workerd bridge provides them), so Durable Object layer types no longer list them. Both services report an unavailable primitive as a defect; boundaries that promise a typed failure map non-interrupt defects to that failure.

Worker routing and DO client acquisition use `makeExecutionMemo`. Generated clients are created inside suspended Effects, in the current invocation's scope. Namespace stubs, HTTP clients, SQL handles, and native cache operations must not escape their owning lifetime. The Worker cache opens lazily during I/O, not during planning.

Twitch app-token lookup caching also belongs to `makeExecutionMemo`: its capacity-one cache and in-flight exchange are invocation-owned, expiry-buffered, and do not retain failed lookups. An unauthorized app request invalidates the token without automatically retrying the operation. This is separate from durable, stream-aware user-token refresh; sharing token values does not authorize sharing an in-flight HTTP request across invocation scopes.

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

`TwitchConfiguration` reads Effect Config during outer initialization, allowing Alchemy to discover bindings. Secrets remain Redacted until final I/O. `TwitchConfigurationError` names the failed setting (for example `TWITCH_CLIENT_SECRET`) and classifies it as `SettingInvalid` or `SettingsUnreadable`; it intentionally omits raw values and parser causes. `twitchConfigurationTestLayer` parses synthetic settings through the production reader. `TwitchAnalytics` writes are best effort; `twitchAnalyticsTestLayer` records them in memory and exposes `TwitchAnalyticsRecording` for assertions.

The stock Effect HTTP tracers collect full URLs, query values, and headers, including OAuth redirect Locations. `twitchHttpTelemetrySafetyLayer` disables that automatic collection for both HTTP servers and clients. It is merged into the **outer exported Worker Layer**, because Alchemy's native HTTP adapter wraps the application handler. Disabling tracing only inside `fetch` is too late.

Public HTTP uses an allowlisted server span with method, path, query keys, status, and server-owned request identity. `x-trace-id` comes from that actual span. Named application spans remain enabled. Generated handler groups are built with empty error reporters because the pinned `HttpApiBuilder` captures construction context and reports before outer middleware. The outer HTTP boundary retains configured reporters and reports a fixed-message failure with safe classification/correlation and a Redacted original cause. The HTTP server span's failed exits omit raw request URLs and defect text; interruption remains visible. Durable events carry explicit correlation IDs. Analytics Engine delivery is best effort; business correctness never depends on successful metric export.

## Pinned-library constraints

Inspect the installed Effect/Alchemy source when changing dependencies. These constraints explain behavior that package versions alone cannot show:

- Use `Schema.TaggedError<Self>()`, not the older remembered `TaggedErrorClass` API.
- Worker/DO HTTP handler contracts are type aliases. Explicit `.make<never>` may be necessary for dependency-free DO constructors to avoid state-requirement inference leaks.
- `HttpRouter.toHttpEffect` requires an invocation Scope; outer Worker initialization does not provide it.
- Use `compatibility: { date, flags }` for Worker properties.
- Worker compatibility is pinned to `2026-09-08`. Keep scenario Workers aligned with the application Worker. The workspace overrides Alchemy's older workerd pin with `1.20260908.1` so local tests support this date. With unpatched Alchemy, the historical `2026-01-13` date fails native startup with `TypeError: t.once is not a function`; updating compatibility resolves it without dependency patches.
