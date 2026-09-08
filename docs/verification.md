# Verification

This document owns check selection, local harness operation, and recorded verification results. The [acceptance ledger](capability-parity.md) owns compatibility requirements and outstanding journeys; the [production gate](production-cutover.md) owns production approval.

## Run the required checks

1. Install from the lockfile with `pnpm install --frozen-lockfile` when preparing a checkout or changing dependencies.

   **Complete when:** installation succeeds and any dependency/lockfile changes are accounted for.

2. Run `pnpm verify` from the repository root after implementation changes. The runner and its order are defined in [run-cf-twitch-verification.ts](../tools/verification/run-cf-twitch-verification.ts); root `package.json` lists focused commands.

   **Complete when:** every required check exits successfully. Fix failures before reporting verification complete, or report the failing command and blocked acceptance scope explicitly.

3. Map changed behavior to its acceptance evidence. Public inference changes need type-level assertions; persistence changes need real storage tests; native lifetime/alarms need workerd evidence where required.

   **Complete when:** each changed requirement has the strongest reliable test result available and any remaining gap is recorded in the acceptance ledger. A typecheck or local pass is not production approval.

For documentation-only changes, check formatting, local links/anchors, and cited source/configuration facts. Source maps and version declarations can be looked up in the environment; keep documentation focused on constraints those lookups cannot explain.

## Focused feedback

Use the root package scripts for lint, types, tooling tests, and API inspection. App-local lint defaults do not replace root policy. For one capability:

```sh
pnpm --filter @cf-twitch/api exec vp test run --config vite.config.ts --mode unit src/features/song-queue
```

`pnpm inspect:api` emits the current paths and generated OpenAPI document without initializing providers, storage, or a Worker. Keep the historical response expectations in the acceptance ledger independent of that generated implementation inventory.

Workspace `build` scripts validate types. Actual Worker bundling, binding discovery, and execution are exercised by local workerd, not implied by a successful build script.

## Evidence boundaries

| Test interface                     | Evidence                                                                                    | Limit                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Portable schema/property tests     | Identity, custom refinements, transformations, transition/roundtrip properties              | No runtime binding or provider evidence       |
| Real SQLite/service tests          | Transactions, migration rejection, deduplication, checkpoints, compensation, reconstruction | No native eviction or alarm scheduling proof  |
| Generated HTTP client/server tests | Wire schemas, status/error projection, authentication, signing, envelopes                   | No Cloudflare namespace-wiring proof          |
| Local Alchemy/workerd scenarios    | Bundling, bindings, actual Worker/DO HTTP, native storage and selected alarms               | No production adoption or live-provider proof |
| Reviewed production inventory      | Actual persisted formats and outstanding work                                               | Not a substitute for behavioral tests         |

Colocated tests exercise each owner. [Cross-capability regressions](../apps/api/test/review/) cover remote commit/response loss and interrupted chat delivery. Preserve their observable invariants when refactoring implementations.

Root tooling tests exercise all custom anti-slop rules through Oxlint RuleTester. [Complexity policy tests](../tools/oxlint/complexity-policy.test.ts) invoke the real root configuration at its allowed/rejected boundary and separately audit both maintained plugin copies. The vendored-source ignore is not an exemption from the complexity policy. The configured ceiling lives in `vite.config.ts`.

## Local workerd harness

Run `pnpm test:e2e:local` from the root, one suite at a time. [run-e2e.ts](../apps/api/scripts/run-e2e.ts) validates the local target and creates a cryptographically unique test stage. Strict ports fail visibly on collision. Use this entrypoint rather than invoking the E2E file without its stage setup; a deployment-guard rejection requires inspecting the permitted invocation, not bypassing it.

The harness provisions through `Test.make({ dev: true, adopt: false })`. A black-box HTTP driver reaches a local Worker, its real HTTP-only Durable Objects, and actual SQL/native storage. External provider HTTP is controlled and closed: an unmatched request fails rather than reaching the public network. No live Twitch/Spotify credentials are needed.

Scenario roots live in [apps/api/test/scenario](../apps/api/test/scenario/) and the [Song Queue scenario](../apps/api/src/features/song-queue/scenario/). Compose controlled dependencies upward through production dependency-preserving Layers, rather than importing a ready graph that can select live providers. Register Durable Objects in the Worker's outer initialization; acquire clients and perform I/O within the invocation scope. See [composition and lifetime](architecture.md#composition-and-lifetime).

**Complete when:** the staged suite passes and scope cleanup leaves no test-owned workerd resources/processes. On failure, preserve available sanitized diagnostics and report which startup, journey, or cleanup step failed. Passing representative journeys does not close the [outstanding native acceptance matrix](capability-parity.md#outstanding-native-acceptance).

### Adding fault journeys

Use controlled responses/recordings for provider protocols, including malformed responses, refusals, delayed completion, and response loss after acceptance. Drive readiness through observable health/state, and retries through supported test-clock/alarm controls rather than multi-minute sleeps or production-only branches. Keep recordings bounded and redact authorization values.

For a new native fault journey, record request/trace correlation, controlled mutation outcomes, and workerd/plan diagnostics needed to distinguish startup failure from recovery failure. A test must assert state through public/internal HTTP interfaces, not private in-memory fields. The acceptance ledger lists the required journeys; implement missing controller capabilities as part of the journey that needs them.

### Telemetry regression

[HTTP request-correlation tests](../apps/api/src/features/http/http-request-correlation.test.ts) capture successful/failed spans and error reports, including the pinned `Cause.prettyErrors({ includeCauseInStack: true })` conversion used by OTLP. They assert secret exclusion while preserving correlation, Redacted causes, and interruption. This is not a live collector test or a claim of native process-eviction coverage. The outer telemetry placement constraint is documented in [observability](architecture.md#observability-and-configuration).

## Recorded verification

Compatibility update (`2026-09-08`): all four Worker declarations use this date, with workerd overridden to `1.20260908.1`. Alchemy's pinned `1.20260704.1` binary rejects the date (maximum supported: `2026-07-11`); the updated binary passes all three native journeys without dependency patches.

Patch-removal regression: the published `alchemy@2.0.0-beta.76` Worker bridge with `effect@4.0.0-rc.112` fails all three native tests at compatibility date `2026-01-13` with `TypeError: t.once is not a function`. Changing all four Worker declarations to Alchemy's default date, `2026-03-17`, makes all three pass without a dependency patch. Verify installed source against the npm tarball when testing patch removal: reinstalling after removing patch registration left patched source behind in the local installation during diagnosis. The snapshot below predates this compatibility correction.

Snapshot date: **2026-09-05**, after the data-flow/complexity cleanup. `pnpm verify` passed formatting, root lint, architecture, OpenAPI inspection, strict root/workspace types, and:

| Suite                 | Passed tests / files |
| --------------------- | -------------------- |
| API unit/interface    | 311 / 43             |
| Contracts             | 12 / 5               |
| Shared infrastructure | 6 / 2                |
| Tooling               | 44 / 3               |
| Local workerd         | 3 / 2                |

The OpenAPI check covered 38 paths and 40 operations; architecture checked 190 source files. `git diff --check` passed. Frozen-lockfile installation was verified in the preceding audit; the cleanup changed no dependencies or lockfile.

Source/configuration snapshot: `4ed326765e40da2d050a5039e55cfbfa22130d10a66838b14db5700b42df78da`. This is SHA-256 of sorted `path + NUL + file-SHA256 + newline` entries for the 264 existing Git-tracked or non-ignored files excluding Markdown. Documentation-only restructuring does not change that snapshot. Detailed local logs were session artifacts, not portable acceptance prerequisites.

The legacy baseline at `8eef994fba90ee9d8af882c712abe5455c13f2dc` passed 368 tests across 39 files. Counts describe snapshots, not parity: the replacement has different test boundaries. Consult the acceptance ledger for what each layer actually demonstrates.
