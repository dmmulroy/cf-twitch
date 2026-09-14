# Effect API reuse audit

Audit date: **2026-09-10**. Source revision: `3282caf5e8a6e98bded06384ab2e9781016d9ff8`.

This report preserves the pre-implementation audit snapshot. See the [implementation follow-up](effect-api-implementation.md) for implemented candidates, conditional dispositions, and subsequent verification.

## Summary

The application already uses Effect extensively and appropriately. The best next work is **targeted API reuse, not another architectural rewrite**.

Start with:

1. **Use instant ordering for Stream Lifecycle.** A real offset-timestamp defect was reproduced; Effect `DateTime` supplies the correct comparison operations.
2. **Replace the generated OpenAPI security traversal with endpoint transforms.** The corrected proposal was structurally identical across all 38 paths and 40 operations.
3. **Use existing Crypto, Encoding, Effect observation/error, and pagination APIs** where they remove platform calls or manual plumbing.
4. Pilot schema-backed SQL queries and stored-row codecs narrowly. Keep domain validation, corruption detection, and transaction ownership.

Keep the custom durable journals, uncertainty records, compensation tombstones, native alarms, occurrence attribution, exact-byte authentication, and compatibility formatters. Effect has relevant abstractions, including a SQL-backed cluster workflow engine, but none is a demonstrated drop-in replacement for those guarantees here.

This is an **audit and implementation backlog**, not an implementation change or production approval. Priorities describe opportunity value, not vulnerability severity. “Candidate” means the API exists and the local fit was inspected; implementation still requires the listed evidence.

## Scope and orchestration

Nine Pi subagents ran in this Herdr workspace, each in its own named tab. Eight had disjoint source ownership; the ninth independently reviewed composition and challenged recommendations. Agents were read-only and communicated through the coordinator. Only the coordinator writes this report and the [file coverage ledger](effect-api-audit-files.md).

| Agent                       | Tab label                       | TypeScript files | Direct Effect-import files |
| --------------------------- | ------------------------------- | ---------------: | -------------------------: |
| `effect-runtime`            | Effect · Runtime & HTTP         |               30 |                         28 |
| `effect-providers`          | Effect · Providers & OAuth      |               28 |                         28 |
| `effect-recovery`           | Effect · Workflows & EventSub   |               20 |                         20 |
| `effect-playback`           | Effect · Song Queue & Raffle    |               25 |                         24 |
| `effect-achievements`       | Effect · Achievements           |               16 |                         15 |
| `effect-events`             | Effect · Events & Stream        |               22 |                         21 |
| `effect-contracts`          | Effect · Contracts & Commands   |               34 |                         31 |
| `effect-tooling`            | Effect · Tests & Infrastructure |               53 |                         22 |
| `effect-review`             | Effect · Independent Review     |    Cross-cutting |              Cross-cutting |
| **Unique maintained files** |                                 |          **228** |                    **189** |

An Oxc AST inventory parsed all **256 Git-tracked TS/JS-family files without parser errors**. The other 28 are bundled, non-Effect installer assets under `.agents/skills/install-anti-slop/`; they were inventoried and excluded from duplicate semantic review. Tests, scenarios, fixtures, declarations, and configuration are included in the 228, not just files importing Effect. Referenced manifests, migration notes, snapshots, and architecture/acceptance documentation were also inspected. Generated output, dependencies as a whole, and production state are not project-source audit coverage.

API authority was the installed **`effect@4.0.0-rc.112`**, matching Effect platform/SQL/test packages, and **`alchemy@2.0.0-beta.76`**. Pinned-source references below are relative to the repository root; `node_modules/effect/src/` is abbreviated **`effect/`**, and `apps/api/node_modules/alchemy/src/` is abbreviated **`alchemy/`**. These are source references, not recommendations to import package internals.

Existing adoption is substantial: direct imports include Effect in 152 files, Schema in 98, Layer in 93, Option in 90, SqlClient in 29, and generated HTTP API/client/server modules throughout the graph. Unused-module counts alone are not a quality metric.

## Composition findings

The reviewed graph is:

```text
Alchemy Stack / Worker outer initialization
  configuration + provider transport + telemetry + Crypto
  capability Layers + thirteen registered Durable Object servers
    ↓ captured values / Layer.succeed bridges
Worker invocation: makeExecutionMemo → scoped router → HTTP handlers
    ↓ generated invocation-owned DO HTTP clients
DO runtime initialization: storage → migrations → recovery → handlers
    ↓ application services
SQL/native state + native alarms + outgoing capability calls
```

The service interfaces represent real authority: providers/authentication, persistence, runtime resources, durable sequencing, or coherent domain policy. Thin generated HTTP adapters are not evidence that those service seams should disappear.

- **Retain outer/inner separation.** Binding registration and stable service capture belong outside; SQL acquisition, migrations, legacy gates, and alarm reconstruction belong in DO runtime initialization. Representative implementations are `workflow-server.ts:50-113` and `eventsub-server.ts:35-96` under `apps/api/src/features/`.
- **Retain `makeExecutionMemo`.** Its invocation-context cache and `Effect.cached` implementation are in `alchemy/Runtime/ExecutionMemo.ts:5-63`. Ordinary isolate-wide `Cache`, `ScopedCache`, or a singleton generated client is not an equivalent lifetime boundary.
- **Retain capability error adapters.** SQL/schema/provider errors have different public meanings; interruption and defects must not become ordinary retryable failures. Blanket `filterStatusOk`, `retryTransient`, `ignoreCause`, or generic error strings would erase evidence.
- **Retain outer telemetry placement.** The Alchemy HTTP adapter wraps the application. Disabling unsafe automatic URL/header capture only inside a handler is too late. Explicit request correlation, Redacted original causes, and safe Analytics Engine projections remain justified.
- **Retain native cache ownership.** Cloudflare Cache API responses, HTTP cache headers, and invocation-bound I/O are not replaced by an in-process Effect lookup cache.
- **Do not standardize every Layer bridge.** `Layer.succeedContext` exists (`effect/Layer.ts:1118-1130`), but replacing searchable value bridges with one Context is optional presentation, not an architectural improvement demonstrated by this audit.

## Adoption candidates

### A01 — High: DateTime ordering for Stream Lifecycle

**Locations:** `apps/api/src/features/stream/stream-state.ts:258-330`, especially `latestTransitionAt`, `acceptOnlineTransition`, and `acceptOfflineTransition`.

The custom implementation compares `IsoTimestamp` strings with `<` and `<=`. The owning schema explicitly permits numeric offsets and multiple precision representations. Lexical order is therefore not instant order.

**Verified counterexample:** the real `acceptOfflineTransition` keeps `LiveStream` for a start of `2026-01-30T12:00:00+02:00` and an end of `2026-01-30T11:00:00Z`. The end is one hour later, and pinned `DateTime.isGreaterThan` correctly returns true.

**Use:** `DateTime.makeUnsafe` only on already-validated `IsoTimestamp`, then `DateTime.isLessThan`, `DateTime.isLessThanOrEqualTo`, or `DateTime.Order`. Pinned source: `effect/DateTime.ts:534-559,680-696,1640-1868`.

Keep the original timestamp strings in storage/events; do not replace `IsoTimestamp` with `Schema.DateTimeUtcFromString`. Preserve strict online freshness and inclusive offline equality. The instant comparison can stay private to the stream owner; no general timestamp service is needed.

**Evidence required:** offset-equivalent representations, genuinely later/earlier offsets, minute/fraction precision, strict versus inclusive equality, and both offline watermark fields in `stream-state.test.ts`; real service/checkpoint tests in `stream.test.ts`. Native restart acceptance remains separate.

### A02 — High: attach OpenAPI security using endpoint Transform annotations

**Locations:** `packages/contracts/src/twitch-api.ts:381,475,590-616`; `TwitchAdminApi`, `TwitchDebugApi`, `openApiMethodNames`, `addAdministratorOpenApiSecurity`, and `generateTwitchOpenApi`.

The file currently walks the generated path/method tree, identifies privileged paths by string prefix, and mutates their security. Use `HttpApiGroup.annotateEndpointsMerge` after each group's final endpoint addition, with **`OpenApi.annotations({ transform: ... })`**, to add security to each completed operation. Delete the method inventory and post-generation traversal; retain the explicit security-scheme component merge.

Pinned sources: `effect/unstable/httpapi/HttpApiGroup.ts:109-116,342-346`; `effect/unstable/httpapi/OpenApi.ts:153-156,197-212,621-629`.

**Important correction:** using the existing `administratorSecurity` **Override** annotation at group level is unsafe. Context merging replaces each endpoint's existing Override, losing pagination/sort parameter metadata on three routes. The coordinator reproduced that loss, then verified that the **Transform** variant produces a structurally identical document: **38 paths, 40 operations**. Existing endpoints have no competing Transform annotation; preserve/combine one explicitly if that changes.

This is documentation metadata only. Do not introduce runtime authentication middleware or alter handler requirements as part of it.

**Evidence required:** a structural generated-document regression, preserving all parameters, response metadata, both security schemes, and public/OAuth/EventSub operations; `pnpm inspect:api` and existing HTTP authentication tests.

### A03 — Medium: use the existing Crypto service for UUIDs and SHA digests

**Locations:**

- `apps/api/src/features/http/http-request-correlation.ts:51-55`: global `crypto.randomUUID()` inside `Effect.sync`.
- `apps/api/src/features/http/eventsub-webhook-handlers.ts:132-137`: direct SHA-256 Promise bridge.
- `apps/api/src/features/stream/stream.ts:67-88`: direct SHA-256 in `deriveLifecycleEventId`.

**Use:** `Crypto.Crypto.randomUUIDv4` and `Crypto.Crypto.digest`. Pinned interface: `effect/Crypto.ts:90-101,145-176`. The Worker already selects `NodeCrypto.layer` at `apps/api/src/runtime/twitch-worker.ts:149-155`.

This removes ambient platform calls and makes cryptographic behavior substitutable through an existing service. Propagate/capture the service through the correct construction phase and update test Layers. Preserve current failure classification: request-ID and stream-ID failures currently defect; receipt digest failure becomes a safe 503. No weak fallback is acceptable.

For stream IDs, preserve the exact input bytes, first sixteen digest bytes, version/variant bits, and UUID formatting. Effect does not supply a compatible replacement for this project's deterministic identity algorithm. Do not replace it with random UUIDs.

**Evidence required:** fixed digest/UUID vectors, leading zeros, spoofed request-ID rejection, typed digest failure/no receipt acceptance, interruption, layer requirement assertions, and local workerd composition evidence.

### A04 — Low: use Encoding instead of manual hexadecimal loops

**Locations:**

- `apps/api/src/features/http/eventsub-webhook-handlers.ts:86-90`: signature hex decoding.
- `apps/api/src/features/stream/stream.ts:81-86`: deterministic UUID hex encoding.
- `apps/api/src/features/workflows/workflow-execution.ts:114-133`: deterministic workflow-event hex encoding.

**Use:** `Encoding.decodeHex` plus `Effect.fromResult`, and `Encoding.encodeHex`. Pinned sources: `effect/Encoding.ts:400-406,434-458`; `effect/Effect.ts:2410-2423`.

Delete conversion loops only. Keep the lowercase-only `sha256=` header schema, exact length, byte authentication order, identity prefix/digest algorithm, and UUID bit manipulation. The decoder's error mapping must fail closed; the prior header schema already supplies the hex-format evidence.

**Evidence required:** fixed HMAC and deterministic identity vectors, leading-zero bytes, malformed prefix/length/non-hex input, and unchanged replay identities.

### A05 — Medium: observe command outcomes without round-tripping the error channel

**Location:** `apps/api/src/features/commands/chat-command-executor.ts:125-158`, `prepare`.

Replace `Effect.result`, manual error observation, and re-failure with `Effect.tapError` and `Effect.tap` around `prepareResponse`. Pinned sources: `effect/Effect.ts:3265-3280,6453-6486`.

This deletes Result plumbing while retaining the original success/error types. Keep no metric for `not_command`, ignored/error classification, Clock-based duration, and no success metric before Twitch delivery. The analytics interface has no typed failure; preserve its best-effort implementation. Defects and interruption must not become command-error metrics.

**Evidence required:** executor metric/fallback tests and interrupted-delivery review tests; a direct interruption assertion if the composition changes.

### A06 — Medium pilot: represent Twitch pagination with Stream.paginate

**Location:** `apps/api/src/features/providers/twitch-service.ts:279-320`, `listEventSubSubscriptions`.

Use `Stream.paginate` and `Stream.runCollect` for the manual cursor/result-array loop. Pinned page/termination implementation: `effect/Stream.ts:1464-1518`.

Carry **cursor and page count** in state. Acquire one app token outside the page function. A remaining cursor on page 100 must fail with the existing `invalid-response`; `Stream.take(100)` is not equivalent because it silently truncates. Preserve page order, empty-page continuation, complete-result semantics, and interruption. This is worthwhile only if the bounded policy stays clearer than the existing loop.

**Evidence required:** `twitch-subscriptions.test.ts` cases for page order, one token, partial failure and 100-page exhaustion, plus an empty page with a continuation cursor.

### A07 — Low: use Effect.option where all typed failures intentionally mean absence

**Locations:** `apps/api/src/features/providers/spotify-service.ts:223-241,364-367` and `apps/api/src/features/events/event-bus.ts:84-88`, `decodeEventOption`.

`getPlaying` discards the error after `Effect.result`; Connect lookup and the Event Bus administrative decoder map success to Some and catch typed failure to None. `Effect.option` directly expresses these policies (`effect/Effect.ts:3529-3570`). Keep corrupt Event Bus raw evidence in SQL; only its administrative projection becomes None.

Keep queue observation authoritative; a failed queue read must still fail the complete observation. Only the intentionally discarded ProviderError channel becomes absence. Defects/interruption remain failures. Do not apply this to provider calls whose error classification controls retry, compensation, or uncertainty.

**Evidence required:** current-playing fallback, queue failure, Connect refusal, and interruption tests through the Spotify service.

### A08 — Low: express workflow timeout classification with timeoutOrElse

**Location:** `apps/api/src/features/workflows/workflow-journal.ts:446-457`, `checkpoint`.

Use `Effect.timeoutOrElse({ duration, orElse })` instead of `timeout` followed by catching `TimeoutError`. Keep the subsequent `Effect.result`. Pinned source: `effect/Effect.ts:8480-8590`.

Preserve the persisted dispatch marker before execution, idempotent timeout → retryable, non-idempotent timeout → unknown, and external interruption as interruption. The pinned operation interrupts its source before evaluating the fallback. `timeoutOption` would erase necessary evidence.

**Evidence required:** raid timeout, non-idempotent commit-gap, restart/deadline, and external-interruption tests.

### A09 — Low: discard only typed best-effort failures with Effect.ignore

**Locations:** `apps/api/src/features/http/http-response-cache.ts:21-22,55-78`, `ignoreCacheFailure`, and the discarded startup recovery result in `apps/api/src/features/stream/stream-server.ts:106`.

Replace the local `Effect.catch(() => Effect.void)` wrapper, or a discarded `Effect.result`, with `Effect.ignore` (`effect/Effect.ts:7720-7775`). This deletes plumbing without changing typed-failure policy. In the Stream server, retain the following `rebuildAlarm` call.

Do not use `ignoreCause`, detach cache writes, or suppress fresh-load/response-encoding failure. Keep native cache writes awaited and interruption observable. Similarly, a discarded `Effect.result` can become `Effect.ignore` only where its value is unused and there is no required warning/reporting side effect.

**Evidence required:** corrupt-hit eviction and cache write tests, rejecting match/delete/put fixtures, and interruption preservation.

### A10 — Low: small existing-module composition APIs

| Location                                                             | Custom form                                 | Existing API                             | Constraint                                                   |
| -------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `apps/api/src/features/eventsub/eventsub-inbox.ts:382-451`           | One-permit `withPermits(1)` calls           | `Semaphore.withPermit`                   | Keep the complete critical section.                          |
| `apps/api/src/features/workflows/workflow-execution.ts:506-511`      | Same                                        | `Semaphore.withPermit`                   | Preserve durable and external-effect serialization.          |
| `apps/api/src/runtime/twitch-worker.ts:142-145`                      | Generator double-yielding the memo accessor | `Effect.flatten(requestRouter)`          | Execute inside invocation scope, not planning.               |
| `apps/api/src/features/achievements/achievement-migrations.ts:22-29` | Ordered yield-in-loop traversal             | `Effect.forEach(..., { discard: true })` | Optional; retain sequential ordering and fail-fast behavior. |

Pinned sources: `effect/Semaphore.ts:78-96,516`; `effect/Effect.ts:2796-2800,1088-1158`. These are small cleanups, not reasons to redesign services. Skip changes that increase local ceremony.

**Evidence required:** current concurrency/interruption tests, runtime Layer inference, and historical migration tests as applicable.

### A11 — Medium: SqlSchema for a structurally unique singleton query

**Location:** `apps/api/src/features/achievements/achievements-database.ts:58,252-258`, `parseSession` / `readSession`.

`SqlSchema.findOneOption({ Request: Schema.Void, Result: StoredSession, execute })` can replace the detached array decoder, first-element access, and Option conversion. Pinned source: `effect/unstable/sql/SqlSchema.ts:148-171`.

This particular query fixes `singleton_id=1`, a primary key with a singleton constraint. First-row semantics cannot conceal duplicate authority here; `Schema.Void` avoids revalidating an already-parsed domain request. Preserve StoredSession fields, ordinary absence, transaction placement, and schema-error classification.

**Do not generalize:** `findOne`/`findOneOption` decode only `arr[0]`, ignoring other rows. Never replace `LIMIT 2` plus duplicate-corruption checks with them. All SqlSchema helpers encode Request first; introducing them everywhere can add redundant work and more code.

**Evidence required:** empty session, corrupt singleton, Stream Opener/transition behavior, real SQL, and unchanged error/requirement inference.

### A12 — Medium pilot: compose the raffle stored-row transformation as a codec

**Location:** `apps/api/src/features/raffle/raffle-database.ts:17-38,91-106`.

A row decoder is followed by manual 0/1-to-boolean projection and a second `RaffleRoll` decoder. `Schema.decodeTo` with `SchemaGetter.transform` can make the stored representation and domain transformation one private codec. Pinned sources: `effect/Schema.ts:5585-5609`; `effect/SchemaGetter.ts:490-523`.

This removes a detached refinement helper and per-read conversion, **not the required domain validation**. The target must still validate distance/winner/record cross-field evidence. Supply the correct reverse transformation; this is not permission to change SQL representations. Keep the pilot only if the resulting codec is clearer than the small current helper.

**Evidence required:** both boolean round trips, independent contradictory-evidence cases, corruption classification, real-SQL receipt replay, concurrent draw, migration and compensation tests.

### A13 — Low: derive immutable raffle replay equivalence from its schema

**Location:** `apps/api/src/features/raffle/raffle-database.ts:169-175`; related comparisons at `:201-205` and `raffle-database.test.ts:102-104`.

Use `Schema.toEquivalence(RecordRaffleRoll)` for immutable-input comparison, and the full result schema for the test's JSON-string comparison. Pinned source: `effect/Schema.ts:15577-15597`.

The projection schema must contain exactly the immutable input fields; do not compare caller input against derived stored distance/winner/record fields. Keep the small get-or-create comparison unless sharing its input schema has a real owner beyond this cleanup. Do not export schemas just for a test.

**Evidence required:** independently conflict every immutable field, accept equal replay, and retain original derived receipt evidence.

### A14 — Low: reuse Schema.Natural through the existing domain alias

**Locations:** `packages/contracts/src/identity.ts:84-88`, and repeated count constraints in `achievement.ts`, `raffle.ts`, and `oauth.ts`.

`Schema.Natural` is the pinned nonnegative safe integer schema, including zero (`effect/Schema.ts:8353-8377`). Keep the public `NonNegativeInt` owner/name and use that alias in consumers; reuse existing `PositiveInt` where appropriate.

This is schema reuse, not a change to units or brands. Compare error output and OpenAPI annotations before adopting: equivalent accepted values do not automatically imply equivalent public diagnostics.

**Evidence required:** zero, positive, negative, fractional, infinite, NaN and unsafe-integer cases, plus affected OpenAPI/HTTP schema output.

### A15 — Medium: use interruptible typed async boundaries in native tests

**Location:** `apps/api/test/e2e.test.ts:278-692`, including direct fetches, OAuth helpers, signed-notification helpers and polling probes.

Many rejecting network/body Promises use `Effect.promise` and fetches do not receive an interruption signal. Use `Effect.tryPromise` and pass its `AbortSignal` into fetch; keep paired body consumption within the same operation's lifetime. Pinned contracts: `effect/Effect.ts:1300-1409`.

This makes rejection classification and cancellation explicit. Assertion failures should remain test failures/defects, not be caught as retryable transport errors; avoid wrapping the entire assertion-bearing helper in a blanket tryPromise. Keep exact signed bytes and the independent HMAC fixture. A safe closed `HttpClient` test boundary is another option, but must preserve redirect-manual behavior and telemetry suppression.

**Evidence required:** fixed signature vectors, existing native journeys, controlled disconnection/refusal, interrupted pending HTTP, and complete scratch-stack/process cleanup. Do not add mutation retries.

### A16 — Low: use @effect/vitest at Effectful Stream test boundaries

**Locations:** `apps/api/src/features/stream/stream-state.test.ts:25-32,117-152` and `stream.test.ts:21-117`.

Use `it.effect` rather than manually invoking `Effect.runPromise` / `runPromiseExit` from ordinary tests; keep pure tests ordinary. Pinned API: `node_modules/@effect/vitest/src/index.ts:169,248`; test-service installation: `src/internal/internal.ts:354-357` in that package.

Keep expected Exit assertions explicit and account for the installed TestClock rather than accidentally mixing live timestamps with virtual time. This is a small test-boundary cleanup, not a replacement for SQLite/native lifetime tests.

**Evidence required:** the focused Stream suites, with unchanged timeout, failure and checkpoint assertions.

## Conditional investigations and deliberate non-adoptions

### D01 — Twitch app-token Cache

`provider-token-exchange.ts:127-131` discards expiry and exchanges for each independent app-authorized operation; `twitch-service.ts:138-157` is a consumer. `Cache.makeWith` supports exit/value-dependent TTL and shared lookups (`effect/Cache.ts:150-218,615-644`). A capacity-one, expiry-buffered cache with zero failure TTL could reduce client-credentials exchanges.

This requires a private expiry-bearing result, invalidation policy, and explicit lifetime design. A token value is not an I/O handle, but sharing an in-flight request across Cloudflare invocations still raises ownership/cancellation concerns. Start with invocation-owned caching; do not assume a Layer-wide concurrent lookup is safe. Test concurrent exchange count, expiry/buffer boundaries, immediate retry after failure, redaction, and native invocation behavior. Keep persisted stream-aware user-token refresh entirely separate.

### D02 — Raffle entropy authority through Crypto.randomBytes

`raffle-random.ts:5-38` owns both an entropy adapter and an exactly uniform rejection sampler. `Crypto.randomBytes(4)` can replace the ambient entropy source and may let the custom service/tag/Layer disappear; the raffle draw operation remains domain-owned.

**Retain rejection sampling.** Pinned `Crypto.randomIntBetween` uses scaled 53-bit floating randomness (`effect/Crypto.ts:255-261`). Since 10,000 does not divide 2^53, it is not an exact-uniform substitute. Effect `Random` is also inappropriate.

Replacing the service itself is optional: the independent reviewer judged `RaffleRandom` earned by its domain-specific draw contract. The narrower first step is to retain that service and replace only its entropy source.

This is conditional because `raffle-server.ts` is dependency-free today and the Crypto requirement must be composed correctly across outer/inner phases. Also verify platform throws versus typed `randomness_unavailable`; `Crypto.make` can invoke a throwing synchronous primitive. Test forced rejection, byte assembly, inclusive bounds, failure projection, two independent draws, no redraw on replay, SQL concurrency, Layer inference and workerd.

### D03 — A real Effect Workflow migration option, not a drop-in

The relevant unused modules are `Workflow`, `Activity`, `DurableClock`, and **`ClusterWorkflowEngine`**. The initial claim that the pinned package only ships a memory engine was challenged and withdrawn.

A durable composition exists: `ClusterWorkflowEngine.layer` (`effect/unstable/cluster/ClusterWorkflowEngine.ts:800-806`) with `SingleRunner.layer` (`SingleRunner.ts:59-77`), SQL message storage and runner storage. Writing a custom `WorkflowEngine.Encoded` is not the only route.

However, replacing `workflow-journal.ts`, `workflow-execution.ts`, `workflow-alarm.ts`, and their server requires proving:

- Native DO wake-up and reconstruction, not just durable SQL. Cluster delayed messages use `deliver_at`; Sharding depends on resident polling/lock-refresh fibers. No inspected pinned bridge installs the corresponding Cloudflare native alarm.
- Current physical DO/redemption/message identity and public status lookup, despite workflow execution-ID hashing.
- Equal-input replay versus conflicting reuse; SQL message dedupe alone does not compare new payload content.
- Persisted dispatch/uncertainty evidence around process loss. Activity interruption retry defaults are not safe for uncertain Spotify/Twitch mutations.
- Reverse compensation, cleanup-before-refund, independent retry progress, fulfillment point-of-no-return, and `OUTCOME_UNKNOWN` / `POST_COMMIT_FAILED` status projection.
- Safe typed boundary errors and current/legacy format gates. Cluster tables are not existing saga-table representations.

Pinned evidence: `ClusterWorkflowEngine.ts:514-550,618-638,745-783`; `SqlMessageStorage.ts:454-552`; `Sharding.ts:430-469,521-567,756-873`; `effect/unstable/workflow/Activity.ts:123-200`; `Workflow.ts:332-361,831-887`.

This deserves a separately scoped design experiment if journal maintenance becomes costly. Require a deletion comparison against the existing journal and all native fault/eviction journeys. Do not launch a migration merely to use the library.

### D04 — PersistedQueue / WorkflowProxy do not replace current contracts

`PersistedQueue` has a SQL implementation (`effect/unstable/persistence/PersistedQueue.ts:753-1212`), but its interrupted take releases work for redelivery (`:1076-1081`). The EventSub inbox must instead hold an uncertain send, compare signed content, retain prepared command responses and leases, and restore native alarms. Reintroducing those policies around a queue would preserve most of today's custom code.

`WorkflowProxy.toHttpApiGroup` and `WorkflowProxyServer.layerHttpApi` generate execute/resume APIs (`effect/unstable/workflow/WorkflowProxy.ts:142-176`, `WorkflowProxyServer.ts:32-91`), not the current `/v1/start`, `/v1/status`, and detailed status projection. Reconsider only with a full engine and compatibility plan.

### D05 — Scoped platform services for subprocess policy tests

`tools/oxlint/complexity-policy.test.ts:2-78` and `readable-spacing-policy.test.ts:2-90` use synchronous Node processes/files and manual temporary-directory cleanup. `FileSystem.makeTempDirectoryScoped`, `ChildProcess.make`, and `ChildProcessSpawner` can supply interruption-aware lifetime (`effect/FileSystem.ts:176-191`; `effect/unstable/process/ChildProcess.ts:603`; `ChildProcessSpawner.ts:236-265`).

Pilot only these subprocess tests. Keep probes under the repository so root policy applies, collect output and exit status from **one** spawned handle, preserve both maintained plugin-copy checks, and prove hanging-child cleanup. If more machinery is required than removed, retain the synchronous boundary and add a bounded process timeout separately. Production verification scripts already use Effect platform processes.

### D06 — Selective SqlSchema.findAll, not persistence-wide conversion

Parameterless reusable reads such as achievement definitions are possible pilots (`achievements-database.ts:52-72,161-165`; `achievement-outbox.ts:31-39`). `SqlSchema.findAll` validates all result rows (`effect/unstable/sql/SqlSchema.ts:33-49`). Its request encoding and extra callback/schema declarations often outweigh deletion for single-use, already-typed queries. Preserve full-row validation, domain constraints and transaction boundaries; do not use it as a decoder-count target.

### D07 — Protocol and request-building follow-ups

- **Spotify Connect compensation status:** `spotify-service.ts:381-403` treats any accepted 2xx as successful removal, whereas other bodyless mutations use `confirmProviderMutationStatus`. This is a **protocol-evidence investigation**, not a proven defect or a ready Effect replacement. Establish the allowed Connect status/body contract before changing success classification. Preserve uncertain response loss, duplicate-URI refusal and one mutation attempt.
- **HTTP-date Retry-After:** `provider-http.ts:35-40` handles numeric seconds only. `DateTime.make` and Clock could support dates, but the pinned HTTP client's parser is private (`effect/unstable/http/HttpClient.ts:1701-1721`). This expands behavior rather than deletes code. Keep caps/fallbacks and never add blanket mutation retries.
- **Effectful JSON request bodies:** `HttpClientRequest.bodyJson` / `schemaBodyJson` exist (`effect/unstable/http/HttpClientRequest.ts:948-1047`). Current bodies are known JSON-safe values. Replacing every `bodyJsonUnsafe` would add failure plumbing without much benefit; reconsider when input provenance changes. Encoding failure is pre-dispatch, not an unknown remote outcome.
- **OAuth query assembly:** `UrlParams.fromInput` / `toString` (`effect/unstable/http/UrlParams.ts:149-174,641-647`) can replace fixed `URL.searchParams.set` calls in `oauth-authorization.ts:81-96`. This is optional, low-value API consistency. Preserve endpoints, scope order, encoding and Redacted URLs.
- **Stream history SQL bounds:** `stream-database.ts:262-279` compares timestamp text, while the API accepts offset-bearing bounds. Inspect this separately from A01 with real-SQL offset-bound tests; do not assume changing TypeScript comparisons fixes SQL ordering.

### D08 — Investigate Stream/Event Bus concurrency before adding another lock

`stream.ts:114-379` has read → outgoing effect → checkpoint-save sequences; `event-bus.ts:115-384` permits alarm/replay/publication decisions before a delivered receipt commits. A service-owned `Semaphore.make(1)` / `withPermit` (`effect/Semaphore.ts:358,516-556`) is a candidate if controlled interleaving demonstrates an unmet serialization requirement.

No such race was reproduced in this audit. Start with Deferred-controlled concurrent tests, not a speculative global lock. Stream reconciliation calls other transition operations, and Event Bus retry calls due processing: nested acquisition could deadlock. One slow subscriber could also block unrelated work; the Achievement inbox already deduplicates delivery. Keep network calls outside SQL transactions, preserve receipts/checkpoints, and prove permit release on failure/interruption. A semaphore never replaces durable restart evidence.

### D09 — A standard JSON body helper without deleting validation

`HttpServerRequest.schemaBodyJson(Schema.Json)` can combine body reading with the required general JSON validation in `twitch-admin-handlers.ts:49,79-85`. Pinned implementation: `effect/unstable/http/HttpIncomingMessage.ts:68-88`; request accessor: `HttpServerRequest.ts:245-253`.

This is an optional low-value replacement for the two-stage helper, not permission to return `request.json` unchecked. Keep authentication first, raw parsed JSON for the historical issue renderer, command-specific decoding afterward, and both parse/schema failures mapped to `400 {"error":"Invalid JSON body"}`. Add scalar and nested numeric-overflow regressions.

## Custom code that should stay

| Mechanism                                                     | Why a generic Effect replacement is not equivalent                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SQL inbox/outbox/receipts/tombstones and native alarms        | They retain durable evidence across eviction; memory queues/caches/schedules do not.                                                                         |
| Song Queue occurrence reconciliation                          | Track identity is not occurrence identity; FIFO attribution, already-playing exclusion and history rules are domain policy.                                  |
| Raffle rejection sampling and cross-field refinements         | Exact uniformity and truthful winner/distance/record evidence must survive any API cleanup.                                                                  |
| Achievement rules and announcement decision                   | Threshold/streak/session rules and definite-refusal versus uncertain-send budgets are application policy.                                                    |
| Command graph, permissions, fingerprints and bounded receipts | Aliases, historical JSON ordering, durable authorization and replay semantics are not generic collection operations.                                         |
| `IsoTimestamp` grammar/calendar filter                        | It preserves offsets/precision and rejects impossible dates. Generic DateTime construction can normalize invalid dates and changes the value representation. |
| Unicode code-point output limit                               | `Array.from(message)` counts code points; pinned `String.length` counts UTF-16 units.                                                                        |
| HMAC verification and constant-time secret comparison         | Pinned Crypto supplies digest/randomness, not HMAC import/sign/verify or equivalent secret equality.                                                         |
| Fixed-allocation signed body reader                           | It bounds adversarial streamed bytes before exact-byte authentication and fatal UTF-8 decoding.                                                              |
| Historical HTTP issue renderer                                | Generic SchemaIssue output is not the frozen public envelope, ordering and wording.                                                                          |
| Parsed-JSON validation in command handlers                    | The transport's `Schema.Json` return type does not establish finite JSON numbers; see the counterexample below.                                              |
| Browser overlay JavaScript                                    | Native AbortController/polling/DOM APIs are appropriate; bundling Effect supplies no demonstrated benefit.                                                   |
| Plain Map/Set, static catalog/fixtures, pure parser/lint code | Standard-library operations and framework contracts are not inherently missing Effect abstractions.                                                          |

## Evidence, rejected proposals, and remaining gaps

### Coordinator verification performed

- Verified pinned manifests/source and inspected architecture, parity, migration and verification requirements.
- Parsed the 256-file tracked source inventory with Oxc: zero parser errors; 189 direct Effect-import files; ownership reconciled to 228 maintained files plus 28 excluded installer assets.
- Executed the **real pure Stream Lifecycle transition** against an offset-bearing counterexample; it retained LiveStream incorrectly. No provider/storage operations were involved.
- Built two **in-memory OpenAPI candidates** using installed Effect APIs. The Override candidate lost six parameter entries across three routes and was rejected. The Transform candidate was structurally equal to the current 38-path/40-operation document.
- Checked a proposed JSON-decoder deletion against numeric overflow. `JSON.parse("1e400")` produces Infinity, while `Schema.decodeUnknownResult(Schema.Json)` rejects it, including when nested. Therefore `HttpServerRequest.json`'s declared result type alone is insufficient evidence to delete `parseCommandJson`. Retain it and add an explicit overflow regression when touching that boundary.
- Inspected Crypto integer generation and rejected exact-uniform claims for `randomIntBetween`.
- Challenged the workflow-engine inventory; the corrected analysis includes SQL-backed ClusterWorkflowEngine instead of claiming no durable implementation exists.

### Verification scope

Report checks passed: focused Oxfmt formatting, whitespace checks on both new files, local links/anchor checks, and an exact file-ledger reconciliation against Git (228 rows, no omissions or duplicates). A specialist reviewed the consolidated main report and found no required corrections. The working tree contains only the two new audit documents.

No application implementation, dependency, stored representation, or deployment configuration was changed. **`pnpm verify` and native suites were not run for this documentation-only audit.** Each implemented follow-up must run its focused acceptance evidence and root `pnpm verify`, as required by [verification](verification.md).

The report does not close the [outstanding native acceptance matrix](capability-parity.md#outstanding-native-acceptance): forced eviction, response loss, alarm recovery, provider rotation, compensation, playback and announcement fault journeys remain separate evidence. No live Twitch/Spotify calls, namespace adoption/transfer, production inventory mutation, or deployment was authorized or performed.

File-level review is a coverage claim, not proof that every future replacement is behaviorally equivalent. Conditional items remain conditional; no runtime migration is approved by this audit.
