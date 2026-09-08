import { expect, it } from "@effect/vitest";
import type { ProviderTokens } from "@cf-twitch/contracts/provider";
import { Clock, Effect, Fiber, Layer, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { ProviderTokenDatabase } from "./provider-token-database.ts";
import { ProviderTokenLifecycle } from "./provider-token-lifecycle.ts";
import {
  providerLocalConfigurationLayer,
  providerLocalTokenLayer,
} from "./provider-local-sql.test-support.ts";
import {
  ProviderScenarioTranscript,
  providerScenarioTransportLayer,
} from "./provider-scenario-transport.test-support.ts";

const tokenInput = (refreshToken: string, expiresIn = 3600): ProviderTokens => ({
  accessToken: Redacted.make("scenario:normal"),
  refreshToken: Option.some(Redacted.make(refreshToken)),
  tokenType: "Bearer",
  expiresIn,
  scopes: ["initial-scope"],
});
for (const provider of ["spotify", "twitch"] as const) {
  const layer = providerLocalTokenLayer(provider).pipe(
    Layer.provide(providerLocalConfigurationLayer),
    Layer.provideMerge(providerScenarioTransportLayer),
  );
  it.effect(
    `${provider} valid offline tokens work but the five-minute expiry boundary never refreshes offline`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const transcript = yield* ProviderScenarioTranscript;
        yield* lifecycle.setTokens(tokenInput("scenario-refresh"));
        expect(Redacted.value(yield* lifecycle.getValidToken())).toBe("scenario:normal");
        yield* TestClock.adjust("55 minutes");
        expect(yield* lifecycle.getValidToken().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "offline" },
        });
        expect(yield* transcript.readRequestCount()).toBe(0);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT due_at_ms FROM local_token_alarm`).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} schedules five minutes early and cancels durable work on stream offline`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const sql = yield* SqlClient.SqlClient;
        yield* lifecycle.setTokens(tokenInput("scenario-refresh"));
        yield* lifecycle.onStreamOnline();
        const now = yield* Clock.currentTimeMillis;
        expect(yield* sql`SELECT due_at_ms FROM local_token_alarm`).toEqual([
          { due_at_ms: now + 3_300_000 },
        ]);
        yield* lifecycle.onStreamOffline();
        expect(yield* sql`SELECT due_at_ms FROM local_token_alarm`).toEqual([]);
        expect(Redacted.value(yield* lifecycle.getValidToken())).toBe("scenario:normal");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} coalesces live refresh across concurrent public callers and persists rotated credentials`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const transcript = yield* ProviderScenarioTranscript;
        const database = yield* ProviderTokenDatabase;
        yield* lifecycle.setTokens(tokenInput("scenario-refresh"));
        yield* lifecycle.onStreamOnline();
        yield* TestClock.adjust("55 minutes");
        const first = yield* lifecycle.getValidToken().pipe(Effect.forkScoped);
        yield* transcript.awaitRefreshStarted();
        const others = yield* Effect.all(
          Array.from({ length: 20 }, () => lifecycle.getValidToken()),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkScoped);
        yield* TestClock.adjust("100 millis");
        const firstToken = yield* Fiber.join(first);
        const otherTokens = yield* Fiber.join(others);
        expect(Redacted.value(firstToken)).toBe("scenario-access-1");
        expect(otherTokens.map(Redacted.value)).toEqual(
          Array.from({ length: 20 }, () => "scenario-access-1"),
        );
        expect(yield* transcript.readRequestCount()).toBe(1);
        const stored = Option.getOrThrow((yield* database.readState()).token);
        expect(Redacted.value(Option.getOrThrow(stored.refreshToken))).toBe("scenario-rotated-1");
        expect(Redacted.value(yield* lifecycle.getValidToken())).toBe("scenario-access-1");
        expect(yield* transcript.readRequestCount()).toBe(1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} retains previous refresh credential when provider omits a rotated credential`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const transcript = yield* ProviderScenarioTranscript;
        const database = yield* ProviderTokenDatabase;
        yield* lifecycle.setTokens(tokenInput("scenario-retain", 1));
        const online = yield* lifecycle.onStreamOnline().pipe(Effect.forkScoped);
        yield* transcript.awaitRefreshStarted();
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(online);
        const stored = Option.getOrThrow((yield* database.readState()).token);
        expect(Redacted.value(Option.getOrThrow(stored.refreshToken))).toBe("scenario-retain");
        expect(Redacted.value(yield* lifecycle.getValidToken())).toBe("scenario-access-1");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} schedules network retries at one, two, four minutes then ten-minute fallback`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const database = yield* ProviderTokenDatabase;
        const sql = yield* SqlClient.SqlClient;
        yield* lifecycle.setTokens(tokenInput("scenario-network", 1));
        for (const [index, delay] of [60_000, 120_000, 240_000, 600_000].entries()) {
          const result = yield* (
            index === 0 ? lifecycle.onStreamOnline() : lifecycle.refreshTokenTick()
          ).pipe(Effect.result);
          expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "network" } });
          const now = yield* Clock.currentTimeMillis;
          expect(yield* sql`SELECT due_at_ms FROM local_token_alarm`).toEqual([
            { due_at_ms: now + delay },
          ]);
          expect((yield* database.readState()).refreshRetryCount).toBe(index === 3 ? 0 : index + 1);
          yield* TestClock.adjust(delay);
        }
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} malformed successful refresh uses ten-minute fallback without leaking provider input`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const sql = yield* SqlClient.SqlClient;
        yield* lifecycle.setTokens(tokenInput("scenario-malformed", 1));
        const result = yield* lifecycle.onStreamOnline().pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-response" } });
        expect(JSON.stringify(result)).not.toContain("scenario-invalid");
        const now = yield* Clock.currentTimeMillis;
        expect(yield* sql`SELECT due_at_ms FROM local_token_alarm`).toEqual([
          { due_at_ms: now + 600_000 },
        ]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} revoked credentials require durable reauthorization and stop all later refresh`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const database = yield* ProviderTokenDatabase;
        const transcript = yield* ProviderScenarioTranscript;
        yield* lifecycle.setTokens(tokenInput("scenario-revoked", 1));
        expect(yield* lifecycle.onStreamOnline().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "reauthorization-required" },
        });
        expect((yield* database.readState()).authorizationStatus).toBe("reauthorization-required");
        expect((yield* database.readState()).nextRefreshAtMs).toEqual(Option.none());
        expect(yield* lifecycle.getValidToken().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "reauthorization-required" },
        });
        yield* lifecycle.refreshTokenTick();
        expect(yield* transcript.readRequestCount()).toBe(1);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    `${provider} absent refresh credentials persist reauthorization-required until successful setup`,
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        const database = yield* ProviderTokenDatabase;
        expect(yield* lifecycle.getValidToken().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "not-configured" },
        });
        expect(
          yield* lifecycle
            .setTokens({ ...tokenInput("unused"), refreshToken: Option.none() })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { kind: "reauthorization-required" } });
        expect((yield* database.readState()).authorizationStatus).toBe("reauthorization-required");
        yield* lifecycle.setTokens(tokenInput("new-consent-refresh"));
        expect((yield* database.readState()).authorizationStatus).toBe("authorized");
        expect(Redacted.value(yield* lifecycle.getValidToken())).toBe("scenario:normal");
      }).pipe(Effect.provide(layer)),
  );
}
