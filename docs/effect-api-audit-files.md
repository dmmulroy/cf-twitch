# Effect API audit — file coverage

Companion to the [prioritized audit](effect-api-audit.md), at source revision `3282caf5e8a6e98bded06384ab2e9781016d9ff8`.

Each row is one fully reviewed maintained TypeScript file, including tests and configuration. Paths are the section prefix plus the filename. **228 unique files**, including **189 with direct Effect imports**. A/D identifiers refer to the main report's adoption candidates/design investigations. “Retain” means no worthwhile replacement was demonstrated, not that every possible defect is ruled out. Test rows identify acceptance relevance, not a new test run.

## Runtime — effect-runtime

Prefix: `apps/api/src/runtime/`

| File                           | Result                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `cloudflare-http-server.ts`    | Retain explicit no-file/no-compression platform; stock HttpPlatform has different capabilities. |
| `twitch-analytics.ts`          | Retain domain metric projection, binding ownership and safe best-effort warnings.               |
| `twitch-configuration.test.ts` | Retain ConfigProvider/Redacted evidence.                                                        |
| `twitch-configuration.ts`      | Config.schema and dependency-preserving Layers already fit.                                     |
| `twitch-layer-types.test.ts`   | Retain planning/runtime requirement assertions; acceptance for Crypto/composition changes.      |
| `twitch-telemetry.ts`          | Retain outer global tracer suppression and Layer.unwrap configuration.                          |
| `twitch-worker.ts`             | A10 Effect.flatten; retain execution memo, native cache delay and captured service bridges.     |

## Public HTTP — effect-runtime

Prefix: `apps/api/src/features/http/`

| File                               | Result                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `eventsub-webhook-handlers.ts`     | A03 Crypto.digest, A04 decodeHex; retain bounded exact-byte reader, fatal UTF-8 and HMAC. |
| `eventsub-webhook.test.ts`         | Fixed signatures, byte conflicts and boundary failures are acceptance for A03/A04.        |
| `http-boundary.ts`                 | Retain constant-time authentication, exact query parsing and safe error envelopes.        |
| `http-request-correlation.test.ts` | Retain span/report/Redacted-cause/interruption tests; A03 acceptance.                     |
| `http-request-correlation.ts`      | A03 Crypto UUID; retain custom safe failed-span/reporting policy.                         |
| `http-response-cache.test.ts`      | A09 acceptance; add rejecting native-operation/interruption cases when changing.          |
| `http-response-cache.ts`           | A09 Effect.ignore; native response cache remains the correct authority.                   |
| `http-test-fixtures.ts`            | Fixed typed schema construction is appropriate.                                           |
| `http-validation-golden.ts`        | Retain independent historical issue envelopes.                                            |
| `http-validation-issues.ts`        | Retain custom issue traversal; generic formatters are not wire-equivalent.                |
| `now-playing-overlay.ts`           | Retain browser-native polling, AbortController, validators and safe DOM rendering.        |
| `twitch-admin-handlers.ts`         | D09 schemaBodyJson(Schema.Json) optional; do not delete finite-JSON validation.           |
| `twitch-admin.test.ts`             | Retain real-SQL command/admin evidence; JSON overflow regression relevant to D09.         |
| `twitch-debug-handlers.ts`         | Existing concurrent reads and explicit partial Results fit.                               |
| `twitch-eventsub-handlers.ts`      | Retain ordered management mutations and honest partial results.                           |
| `twitch-http-api.ts`               | Retain handler graph and construction-time empty reporters.                               |
| `twitch-http.test.ts`              | HTTP/authentication/validation acceptance; no test abstraction replacement needed.        |
| `twitch-oauth-handlers.ts`         | Retain one-use consumption order, Redacted code and boundary classification.              |
| `twitch-oauth.test.ts`             | Retain durable-state order and secret-exclusion evidence.                                 |
| `twitch-overlay-handlers.ts`       | Static response delegation is already minimal.                                            |
| `twitch-public-handlers.ts`        | Existing Schema, Option and error projections fit.                                        |
| `twitch-stats-handlers.ts`         | Retain native cache integration and owner response encoding.                              |
| `viewer-stats-debug.ts`            | Existing Effect.all/Result/Option preserves independent partial failures.                 |

## Providers — effect-providers

Prefix: `apps/api/src/features/providers/`

| File                                          | Result                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `provider-access-tokens.ts`                   | Retain cohesive durable access-token capability.                                              |
| `provider-http-security.test.ts`              | Retain tracer suppression and secret-exclusion evidence.                                      |
| `provider-http.ts`                            | D07 Retry-After investigation; retain mutation/status/timeout/decode distinctions.            |
| `provider-local-sql.test-support.ts`          | Real SQLite and controlled alarm register fit.                                                |
| `provider-scenario-transport.test-support.ts` | Retain closed transport, Deferred/Ref synchronization and bounded safe transcript.            |
| `provider-token-client.ts`                    | Retain suspended generated clients, execution scope and error translation.                    |
| `provider-token-database.test.ts`             | Retain persistence/reconstruction/corruption evidence.                                        |
| `provider-token-database.ts`                  | Retain evidence-first imports, complete row parsing and current representation.               |
| `provider-token-exchange.test.ts`             | Retain controlled forms/auth/status/rotation evidence; D01 acceptance.                        |
| `provider-token-exchange.ts`                  | D01 expiry-aware app-token cache; bodyUrlParams/basicAuth already used.                       |
| `provider-token-http-api.ts`                  | Internal Redacted credential schemas fit.                                                     |
| `provider-token-http-handlers.ts`             | Thin lifecycle delegation already minimal.                                                    |
| `provider-token-lifecycle.test.ts`            | TestClock and explicit refresh barriers fit; retain rotation/recheck evidence.                |
| `provider-token-lifecycle.ts`                 | Retain cached single-flight, semaphore recheck, rotation acceptance and durable retry alarms. |
| `provider-token-migration.test.ts`            | Retain original-source and scheduling-evidence preservation.                                  |
| `provider-token-server.ts`                    | Correct outer exchange capture and inner SQL/alarm recovery.                                  |
| `spotify-service.test.ts`                     | A07 acceptance; D07 Connect-status investigation needs protocol evidence.                     |
| `spotify-service.ts`                          | A07 Effect.option; D07 body construction and Connect-status follow-ups; ambiguity retained.   |
| `twitch-service.test.ts`                      | Retain definite-delivery and single-attempt uncertainty tests.                                |
| `twitch-service.ts`                           | A06 bounded Stream pagination pilot, D01 app-token cache; no automatic mutation retry.        |
| `twitch-subscriptions.test.ts`                | A06 ordered pages/one token/exhaustion evidence; add empty-page continuation if changed.      |

## OAuth — effect-providers

Prefix: `apps/api/src/features/oauth/`

| File                           | Result                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `oauth-authorization.ts`       | D07 optional UrlParams assembly; Crypto/Clock/state-before-exchange already fit.   |
| `oauth-contract.test.ts`       | Retain property/redaction evidence.                                                |
| `oauth-state-client.ts`        | Existing bounded Cache inside execution memo fits multi-state invocation lifetime. |
| `oauth-state-http-api.ts`      | Generated schema contract appropriate.                                             |
| `oauth-state-http-handlers.ts` | Minimal service delegation.                                                        |
| `oauth-state-server.ts`        | Correct two-phase native-storage composition.                                      |
| `oauth-state-store.ts`         | Retain native one-use transactions, malformed-state preservation and alarm repair. |

## Workflows — effect-recovery

Prefix: `apps/api/src/features/workflows/`

| File                         | Result                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `workflow-alarm.ts`          | Retain native alarm adapter; D03 needs an explicit native wake-up bridge.                          |
| `workflow-client.ts`         | Retain execution-scoped generated clients and existing status transport; D04.                      |
| `workflow-execution.test.ts` | Retain real-SQL replay/compensation/timeout/post-commit evidence; A08/A10 acceptance.              |
| `workflow-execution.ts`      | A04 hex encoding, A10 withPermit; retain domain sequencing, stable IDs and uncertainty.            |
| `workflow-http-api.ts`       | Retain current start/status contract; WorkflowProxy is not equivalent (D04).                       |
| `workflow-http-handlers.ts`  | Minimal service-backed handlers; retain status meaning.                                            |
| `workflow-journal.test.ts`   | Retain corruption, restart, scheduling, dispatch gap, exhaustion and format-gate evidence.         |
| `workflow-journal.ts`        | A08 timeoutOrElse; D03 cluster-engine investigation only; keep durable journal/cardinality checks. |
| `workflow-server.ts`         | Correct outer capture, inner SQL/recovery and native alarms; D03 topology constraints.             |
| `workflow-starters.ts`       | Namespace routing is an earned application service.                                                |

## EventSub — effect-recovery

Prefix: `apps/api/src/features/eventsub/`

| File                        | Result                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `eventsub-client.ts`        | Existing execution-owned Cache/client lifetime appropriate.                                             |
| `eventsub-dispatch.ts`      | Retain authenticated event routing, source timestamps and typed error projection.                       |
| `eventsub-http-api.ts`      | Generated versioned API already fits.                                                                   |
| `eventsub-http-handlers.ts` | Thin service delegation appropriate.                                                                    |
| `eventsub-inbox.test.ts`    | Retain SQL/HTTP/TestClock conflict, retry, lease and interrupted-send evidence.                         |
| `eventsub-inbox.ts`         | A10 withPermit; retain digest conflict, leased dispatch, chat checkpoints and uncertainty (D04).        |
| `eventsub-message.test.ts`  | Retain contradiction, unknown variant, timestamp and spoofing properties.                               |
| `eventsub-message.ts`       | Retain header/body discrimination and prototype-safe reconstruction; TaggedUnion alone is insufficient. |
| `eventsub-receipts.ts`      | Cohesive durable receipt interface/tag appropriate.                                                     |
| `eventsub-server.ts`        | Correct runtime-only legacy gate, SQL, alarm reconstruction and HTTP scope.                             |

## Song Queue — effect-playback

Prefix: `apps/api/src/features/song-queue/`

| File                                      | Result                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scenario/song-queue-scenario-worker.ts`  | Retain controlled provider, Ref state and execution-owned Worker graph.                              |
| `scenario/song-queue-scenario.workerd.ts` | Retain black-box native HTTP/DO journey and real-time fixture boundary.                              |
| `song-queue-alarm.ts`                     | Native scheduling/error authority is necessary.                                                      |
| `song-queue-client.ts`                    | Existing execution memo and explicit transport errors fit.                                           |
| `song-queue-database.test.ts`             | Retain transactions, migration, corruption, history and attribution evidence.                        |
| `song-queue-database.ts`                  | Retain current codecs, transactions, instant SQL ordering and replay receipts; no blanket SqlSchema. |
| `song-queue-http-api.ts`                  | Versioned wire schemas appropriate.                                                                  |
| `song-queue-http-handlers.ts`             | Minimal capability delegation.                                                                       |
| `song-queue-reconciliation.test.ts`       | Focused occurrence/FIFO properties appropriate.                                                      |
| `song-queue-reconciliation.ts`            | Retain domain-specific occurrence algorithm and simple Map/Set indices.                              |
| `song-queue-server.ts`                    | Correct outer Spotify capture and inner SQL/alarm startup.                                           |
| `song-queue-service.test.ts`              | Retain coalescing/backoff/stale-fallback/HTTP/SQL evidence.                                          |
| `song-queue-service.ts`                   | Semaphore already fits; keep durable freshness/backoff and alarm multiplexing, not Cache/Schedule.   |
| `song-queue.ts`                           | Cohesive service and ordinary Option absence appropriate.                                            |

## Raffle — effect-playback

Prefix: `apps/api/src/features/raffle/`

| File                           | Result                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `raffle-client.ts`             | Correct generated client/execution/error boundary.                                                |
| `raffle-database.test.ts`      | A13 schema-derived result equivalence; A12/D02 real-SQL acceptance.                               |
| `raffle-database.ts`           | A12 stored-row codec pilot, A13 immutable equivalence; retain receipts/tombstones/transactions.   |
| `raffle-historical.fixture.ts` | Retain frozen migration evidence independently of current schemas.                                |
| `raffle-http-api.ts`           | Schemas and Option wire encoding fit.                                                             |
| `raffle-http-handlers.ts`      | Minimal service delegation.                                                                       |
| `raffle-migration.test.ts`     | Retain historical adoption/rejection and SQL constraint evidence.                                 |
| `raffle-random.test.ts`        | D02 should add deterministic rejected-word and failure cases; distribution smoke is insufficient. |
| `raffle-random.ts`             | D02 Crypto byte source; keep exact-uniform sampler, domain contract and typed failure.            |
| `raffle-server.ts`             | Correct inner SQL; D02 adds a construction-phase Crypto requirement.                              |
| `raffle-service.ts`            | Cohesive public capability, errors and ordinary absence fit.                                      |

## Achievements — effect-achievements

Prefix: `apps/api/src/features/achievements/`

| File                                 | Result                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `achievement-announcement.test.ts`   | Retain uncertainty, retry-budget and Retry-After properties.                                               |
| `achievement-announcement.ts`        | Retain persisted retry-decision policy; Schedule is not durable replacement.                               |
| `achievement-migration.test.ts`      | Retain real-SQL historical import/rejection evidence.                                                      |
| `achievement-migrations.ts`          | A10 optional sequential forEach; retain frozen ordered SQL and fail-closed adoption.                       |
| `achievement-outbox.test.ts`         | Retain SQL/TestClock/concurrency/response-loss evidence; native eviction remains separate.                 |
| `achievement-outbox.ts`              | D06 selective SqlSchema pilot only; preserve generation fencing and separate chat/metric states.           |
| `achievement-rules.test.ts`          | Focused threshold/streak/equivalent-instant properties fit.                                                |
| `achievement-rules.ts`               | Retain domain rules and already-correct Date.parse instant comparisons; no gratuitous DateTime conversion. |
| `achievements-client.ts`             | Correct execution lifetime, generated transport and error translation.                                     |
| `achievements-database.test.ts`      | A11 acceptance; retain rollback/concurrency/rehydration/domain tests.                                      |
| `achievements-database.ts`           | A11 singleton SqlSchema; D06 findAll pilot; transactional progress/outbox semantics retained.              |
| `achievements-historical.fixture.ts` | Retain independent frozen compatibility evidence.                                                          |
| `achievements-http-api.ts`           | Existing HttpApi/Schema design fits.                                                                       |
| `achievements-http-handlers.ts`      | Minimal type-safe delegation.                                                                              |
| `achievements-server.ts`             | Correct outer capability capture/inner SQL recovery; native alarms retained.                               |
| `achievements-service.ts`            | Cohesive domain interface/tag and precise errors fit.                                                      |

## Events — effect-events

Prefix: `apps/api/src/features/events/`

| File                           | Result                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `achievement-event-handler.ts` | Retain consumer error translation and Layer ownership.                                         |
| `event-bus-client.ts`          | Invocation memo and shared Layer acquisition fit.                                              |
| `event-bus-database.test.ts`   | Retain migration/corruption evidence.                                                          |
| `event-bus-database.ts`        | Retain transactions, full row decoding, receipts and deadline queries.                         |
| `event-bus-http-api.ts`        | Versioned schema contract appropriate.                                                         |
| `event-bus-http-handlers.ts`   | Minimal typed adapter.                                                                         |
| `event-bus-server.ts`          | Correct runtime-only storage and alarm recovery.                                               |
| `event-bus-service.ts`         | Cohesive consumer/publisher/administration contracts appropriate.                              |
| `event-bus.test.ts`            | Retain receipts/retry/quarantine/deadline evidence; D08 concurrency investigation.             |
| `event-bus.ts`                 | A07 Effect.option projection; D08 serialization investigation; retain durable retry/DLQ state. |
| `event-publisher.ts`           | Intentional public re-export, no new abstraction required.                                     |

## Stream — effect-events

Prefix: `apps/api/src/features/stream/`

| File                         | Result                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `stream-database.test.ts`    | Retain provenance/migration rejection; D07 SQL-bound tests needed if investigated.                        |
| `stream-database.ts`         | D07 instant SQL bounds investigation; current/legacy authority decoding retained.                         |
| `stream-http-api.ts`         | Versioned schema contract appropriate.                                                                    |
| `stream-http-handlers.ts`    | Minimal service delegation.                                                                               |
| `stream-lifecycle-client.ts` | Correct invocation lifetime and transport error mapping.                                                  |
| `stream-lifecycle.ts`        | Cohesive source-transition/read contract appropriate.                                                     |
| `stream-server.ts`           | A09 Effect.ignore startup outcome; retain subsequent alarm rebuild and construction phases.               |
| `stream-state.test.ts`       | A01 offset-order regression home; A16 it.effect at asynchronous boundaries.                               |
| `stream-state.ts`            | A01 confirmed lexical-versus-instant ordering defect; preserve representation and checkpoint refinements. |
| `stream.test.ts`             | A16 it.effect; D08 controlled interleaving evidence needed; recovery coverage retained.                   |
| `stream.ts`                  | A03/A04 Crypto/Encoding; D08 mutation/checkpoint serialization investigation.                             |

## Contracts — effect-contracts

Prefix: `packages/contracts/`

| File                        | Result                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/achievement.ts`        | A14 scalar alias reuse; retain Option fields, rule metadata and errors.                                 |
| `src/chat-command.test.ts`  | Retain strict-excess and unary parser evidence.                                                         |
| `src/chat-command.ts`       | Retain domain variants, refinements and parser wrappers; TaggedUnion utilities offer no clear deletion. |
| `src/domain-event.test.ts`  | Schema-derived properties and JSON replay evidence fit.                                                 |
| `src/domain-event.ts`       | Retain JSON codec, versioning and raffle cross-field refinements.                                       |
| `src/event-bus.test.ts`     | Appropriate schema/interface evidence.                                                                  |
| `src/event-bus.ts`          | Durable operation/error and Option contracts fit.                                                       |
| `src/eventsub.ts`           | Retain signed header/digest/status contracts; cryptographic I/O remains outside package.                |
| `src/identity.test.ts`      | Retain generated valid and impossible-calendar cases; A14 scalar acceptance.                            |
| `src/identity.ts`           | A14 Schema.Natural behind NonNegativeInt; retain strict offset-preserving IsoTimestamp.                 |
| `src/oauth.ts`              | A14 scalar alias reuse; retain Redacted state and original branded redirect strings.                    |
| `src/provider.ts`           | Retain Redacted credentials and mutation-ambiguity vocabulary.                                          |
| `src/raffle.ts`             | A14 scalar reuse; retain all cross-field evidence checks.                                               |
| `src/redemption.ts`         | Meaningful identity/fulfillment contract; no replacement.                                               |
| `src/song-queue.ts`         | Retain occurrence types and already-correct instant-bound refinement.                                   |
| `src/spotify-track.test.ts` | Focused accepted-link/property/security cases fit.                                                      |
| `src/spotify-track.ts`      | Retain domain link/URI grammar; URL schema transformation changes representation.                       |
| `src/stream.ts`             | Retain durable transition/checkpoint fields and representation.                                         |
| `src/twitch-api.ts`         | A02 corrected OpenAPI endpoint Transform; keep public compatibility schema/metadata owner.              |
| `src/workflow.ts`           | Retain durable statuses, uncertainty and lookup identity; D03/D04 are migrations.                       |
| `vite.config.ts`            | Root policy inheritance appropriate.                                                                    |

## Commands — effect-contracts

Prefix: `apps/api/src/features/commands/`

| File                            | Result                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `chat-command-executor.test.ts` | Retain real-interface Layers, Clock, metrics and code-point bounds; A05 acceptance.                         |
| `chat-command-executor.ts`      | A05 tap/tapError; retain permissions, cosmetic Random.choice and preparation/delivery split.                |
| `command-defaults.ts`           | Retain historical viewer-facing catalog and migration IDs.                                                  |
| `command-permissions.ts`        | Concise domain rank/badge policy; no collection rewrite.                                                    |
| `commands-client.ts`            | Correct execution lifetime and necessary generated-union overload narrowing.                                |
| `commands-database.test.ts`     | Retain SQL/corruption/replay/concurrency/migration/bounded-journal evidence.                                |
| `commands-database.ts`          | Retain atomic snapshot, alias graph, durable permission check and ordered fingerprints/receipts.            |
| `commands-http-api.test.ts`     | Existing generated server/client and acquireRelease lifetime fit.                                           |
| `commands-http-api.ts`          | Internal versioned schema contract appropriate.                                                             |
| `commands-http-handlers.ts`     | Minimal capability delegation.                                                                              |
| `commands-server.ts`            | Correct two-phase storage and HTTP scope.                                                                   |
| `commands.ts`                   | Cohesive interface/tag; no built-in replacement.                                                            |
| `computed-chat-commands.ts`     | Retain independent concurrent reads, historical fallbacks, Eastern-time formatter and idempotent mutations. |

## App tooling and cross-capability tests — effect-tooling

Prefix: `apps/api/`

| File                                              | Result                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `alchemy.run.ts`                                  | Retain explicit safe stage/deployment composition; no audit-time provisioning.                               |
| `scripts/inspect-api.ts`                          | Existing Effect-based schema inventory script appropriate.                                                   |
| `scripts/run-e2e.ts`                              | Existing Config/stage/Crypto/platform process boundary appropriate.                                          |
| `test/e2e.test.ts`                                | A15 typed interruptible network boundaries; retain real-time native polling and independent signing fixture. |
| `test/review/commands-eventsub-review.test.ts`    | Retain Deferred/Fiber/Ref/TestClock interrupted-send evidence.                                               |
| `test/review/commands-workflow-review.test.ts`    | Retain real-SQL reconstruction and commit-plus-response-loss evidence.                                       |
| `test/scenario/full-worker-scenario.ts`           | Correct controlled dependency graph and execution-owned clients.                                             |
| `test/scenario/oauth-scenario-stack.ts`           | Explicit scenario resource graph appropriate.                                                                |
| `test/scenario/oauth-scenario-worker.ts`          | Correct native state/Worker graph and invocation-scoped runtime I/O.                                         |
| `test/support/controlled-twitch-service.ts`       | Faithful closed transport rather than module mocks.                                                          |
| `test/support/recording-twitch-analytics.test.ts` | Shared recording/service behavior evidence appropriate.                                                      |
| `test/support/recording-twitch-analytics.ts`      | Layer.effectContext correctly exposes production and control tags from one Ref.                              |
| `vite.config.ts`                                  | Unit/native separation and inherited root policy appropriate.                                                |

## Shared infrastructure — effect-tooling

Prefix: `packages/shared-infrastructure/`

| File                                         | Result                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `src/cf-twitch-analytics-dataset.test.ts`    | Binding descriptor/stage evidence appropriate.                   |
| `src/cf-twitch-analytics-dataset.ts`         | Real Analytics Engine binding owner appropriate.                 |
| `src/cf-twitch-infrastructure-stage.test.ts` | Stage/parser/isolation properties appropriate.                   |
| `src/cf-twitch-infrastructure-stage.ts`      | Already uses Config.schema, Crypto UUID and narrow typed parser. |
| `src/index.ts`                               | Explicit package exports appropriate.                            |
| `vite.config.ts`                             | Root policy inheritance appropriate.                             |

## Root configuration — effect-tooling

Prefix: `./`

| File             | Result                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| `vite.config.ts` | Active root lint/format/complexity policy inspected; no new rule proposed or installed. |

## Maintained tools — effect-tooling

Prefix: `tools/`

| File                                                                          | Result                                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `architecture/check-cf-twitch-architecture.test.ts`                           | Existing parser/import evidence appropriate.                                                          |
| `architecture/check-cf-twitch-architecture.ts`                                | Already uses FileSystem/Path/Schema/NodeServices; Oxc parsing remains a legitimate external boundary. |
| `verification/run-cf-twitch-verification.ts`                                  | Already uses Effect platform processes; retain visible ordered check sequence.                        |
| `oxlint/complexity-policy.test.ts`                                            | D05 scoped process/filesystem pilot; retain actual-root and duplicate-copy checks.                    |
| `oxlint/readable-spacing-policy.test.ts`                                      | D05 scoped process/filesystem pilot; retain exact fixes and formatter convergence.                    |
| `oxlint/anti-slop/anti-slop-rules.test.ts`                                    | Synchronous RuleTester boundary intentionally retained, despite Effect test imports.                  |
| `oxlint/anti-slop/index.ts`                                                   | Pure Oxlint plugin entrypoint; intentional Effect exclusion.                                          |
| `oxlint/anti-slop/effect/index.ts`                                            | Rule export metadata, not an Effect runtime service.                                                  |
| `oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts`             | ESTree policy implementation; retain framework-native visitor.                                        |
| `oxlint/anti-slop/rules/no-chained-type-assertions.ts`                        | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts`                | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-known-value-widening.ts`                           | Pure AST/type-evidence analysis; no Effect conversion.                                                |
| `oxlint/anti-slop/rules/no-module-mocking.ts`                                 | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-object-parameters.ts`                              | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-reflect-apply.ts`                                  | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-reflect-get.ts`                                    | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-runtime-typeof.ts`                                 | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-shape-in-symbol-names.ts`                          | Pure naming-policy analysis; no Effect conversion.                                                    |
| `oxlint/anti-slop/rules/no-unknown-parameters.ts`                             | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-unknown-returns.ts`                                | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-unknown-type-aliases.ts`                           | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-unsafe-dictionary-type.ts`                         | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/no-widen-then-assert.ts`                              | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/rules/require-readable-spacing.ts`                          | Framework fixer/spacing contract; no Effect conversion.                                               |
| `oxlint/anti-slop/rules/require-safety-comment-for-type-assertion.ts`         | Pure rule visitor; no Effect conversion.                                                              |
| `oxlint/anti-slop/shared/dictionary-types.ts`                                 | Pure reusable AST analysis; no Effect conversion.                                                     |
| `oxlint/anti-slop/shared/function-parameters.ts`                              | Pure reusable AST analysis; no Effect conversion.                                                     |
| `oxlint/anti-slop/shared/lexical-type-parameters.ts`                          | Pure lexical-scope analysis; no Effect conversion.                                                    |
| `oxlint/anti-slop/shared/reflect-method.ts`                                   | Pure AST helper; no Effect conversion.                                                                |
| `oxlint/anti-slop/shared/type-alias-resolution.ts`                            | Pure scoped alias analysis; no Effect conversion.                                                     |
| `oxlint/anti-slop/vendor/eslint-stylistic/padding-line-ast.ts`                | Vendored framework AST contract; retain provenance and native types.                                  |
| `oxlint/anti-slop/vendor/eslint-stylistic/padding-line-between-statements.ts` | Vendored synchronous rule/fixer; no Effect conversion.                                                |
| `oxlint/anti-slop/vendor/eslint-stylistic/padding-line-options.d.ts`          | Vendor declaration; no runtime Effect opportunity.                                                    |

## Additional evidence and exclusions

These are outside the 228 TypeScript rows:

- Root `AGENTS.md`, `CONTEXT.md`, manifests/lockfile/workspace/TypeScript configuration and the architecture, capability-parity, verification, cutover and historical-audit documents governed the review.
- Package manifests/configuration were checked against installed versions, not current web examples. Generated lockfile sections establish dependency inventory, not application semantics.
- Owner notes read: `commands-migration.md`, `song-queue-migration.md`, `providers/provider-migration-notes.md`, `achievements/rewards-verification.md`, and `workflows/WORKFLOW-MIGRATION.md` beneath their feature roots. Stream/Event Bus legacy notes are in the cutover document.
- `apps/api/src/features/commands/__snapshots__/commands-database.test.ts.snap` was reviewed as independent historical catalog evidence; it is not a TypeScript source file.
- Shared-infrastructure README, plugin provenance documents and vendored license were inspected; no new tooling policy was installed.
- The **28 tracked TypeScript installer-asset files** under `.agents/skills/install-anti-slop/` have no direct Effect imports and are duplicated non-Effect distribution assets. Their paths/imports were inventoried; duplicate semantic review was explicitly excluded.
- `node_modules`, generated `.alchemy`/`.vite` output, untracked runtime state and production persisted data are excluded. Only the pinned dependency API/runtime source relevant to recommendations was inspected, not every dependency file.

Coverage means source review plus API-fit analysis. It does not assert passing test suites, native fault coverage, stored-production compatibility or permission to deploy.
