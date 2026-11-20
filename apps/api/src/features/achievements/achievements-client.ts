import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  AchievementError,
  type AchievementErrorIdentifiers,
  type AchievementOperation,
  achievementErrorIdentifiersForDisplayName,
  achievementErrorIdentifiersForDomainEvent,
  achievementErrorIdentifiersForEventInput,
  achievementErrorIdentifiersForReset,
  achievementErrorWithoutIdentifiers,
} from "@cf-twitch/contracts/achievement";
import { Achievements } from "./achievements-service.ts";
import { AchievementsHttpApi } from "./achievements-http-api.ts";
import { AchievementsServer, achievementsServerLayer } from "./achievements-server.ts";

/**
 * Translates achievements HTTP client failures into `AchievementError`.
 *
 * A transport failure or unreadable response leaves a mutation's outcome unknown; the error message
 * directs callers to the idempotent retry each operation supports.
 *
 * @returns An `Effect.fn` transform whose effect fails only with `AchievementError`: the server's own
 *   `AchievementError` unchanged, `transport_unavailable` for `HttpClientError`, and
 *   `invalid_response` for `SchemaError`.
 */
const translateAchievementsClientErrors =
  <Args extends ReadonlyArray<unknown>>(
    operation: AchievementOperation,
    identify: (...args: Args) => AchievementErrorIdentifiers,
  ) =>
  <A>(
    effect: Effect.Effect<
      A,
      AchievementError | HttpClientError.HttpClientError | Schema.SchemaError
    >,
    ...args: Args
  ): Effect.Effect<A, AchievementError> => {
    const identifiers = identify(...args);

    return effect.pipe(
      Effect.catchTags({
        AchievementError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(
            new AchievementError({ operation, reason: "transport_unavailable", ...identifiers }),
          ),
        SchemaError: () =>
          Effect.fail(
            new AchievementError({ operation, reason: "invalid_response", ...identifiers }),
          ),
      }),
    );
  };

/**
 * Effect that builds the achievements client over the `AchievementsDO` namespace.
 *
 * **Details**
 *
 * One HTTP client is memoized per execution; invocation-scoped stubs are never retained globally.
 *
 * @returns The `Achievements` client; building it cannot fail. Its methods fail with the server's
 *   `AchievementError`, or with `transport_unavailable` or `invalid_response` when the server cannot
 *   be reached or understood.
 */
export const makeAchievementsClient = Effect.gen(function* () {
  const namespace = yield* AchievementsServer;

  const client = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(AchievementsHttpApi, {
        baseUrl: "http://achievements.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName("achievements")),
      }),
    ),
  );

  return Achievements.of({
    handleEvent: Effect.fn("AchievementsClient.handleEvent")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.handleEvent({ payload: { event: input } });
      },
      translateAchievementsClientErrors("handleEvent", achievementErrorIdentifiersForDomainEvent),
    ),
    recordEvent: Effect.fn("AchievementsClient.recordEvent")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.recordEvent({ payload: input });
      },
      translateAchievementsClientErrors("recordEvent", achievementErrorIdentifiersForEventInput),
    ),
    getDefinitions: Effect.fn("AchievementsClient.getDefinitions")(
      function* () {
        const http = yield* client;

        return yield* http.achievements.getDefinitions();
      },
      translateAchievementsClientErrors("getDefinitions", () => achievementErrorWithoutIdentifiers),
    ),
    getUserAchievements: Effect.fn("AchievementsClient.getUserAchievements")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.getUserAchievements({ payload: input });
      },
      translateAchievementsClientErrors(
        "getUserAchievements",
        achievementErrorIdentifiersForDisplayName,
      ),
    ),
    getUnlockedAchievements: Effect.fn("AchievementsClient.getUnlockedAchievements")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.getUnlockedAchievements({ payload: input });
      },
      translateAchievementsClientErrors(
        "getUnlockedAchievements",
        achievementErrorIdentifiersForDisplayName,
      ),
    ),
    getLeaderboard: Effect.fn("AchievementsClient.getLeaderboard")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.getLeaderboard({ payload: input });
      },
      translateAchievementsClientErrors("getLeaderboard", () => achievementErrorWithoutIdentifiers),
    ),
    getUnannounced: Effect.fn("AchievementsClient.getUnannounced")(
      function* () {
        const http = yield* client;

        return yield* http.achievements.getUnannounced();
      },
      translateAchievementsClientErrors("getUnannounced", () => achievementErrorWithoutIdentifiers),
    ),
    getDebugTableCounts: Effect.fn("AchievementsClient.getDebugTableCounts")(
      function* () {
        const http = yield* client;

        return yield* http.achievements.getDebugTableCounts();
      },
      translateAchievementsClientErrors(
        "getDebugTableCounts",
        () => achievementErrorWithoutIdentifiers,
      ),
    ),
    getDebugUserSnapshot: Effect.fn("AchievementsClient.getDebugUserSnapshot")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.getDebugUserSnapshot({ payload: input });
      },
      translateAchievementsClientErrors(
        "getDebugUserSnapshot",
        achievementErrorIdentifiersForDisplayName,
      ),
    ),
    resetOneTimeAchievements: Effect.fn("AchievementsClient.resetOneTimeAchievements")(
      function* (input) {
        const http = yield* client;

        return yield* http.achievements.resetOneTimeAchievements({ payload: input });
      },
      translateAchievementsClientErrors(
        "resetOneTimeAchievements",
        achievementErrorIdentifiersForReset,
      ),
    ),
  });
});

/** Layer that provides the achievements client while leaving the `AchievementsDO` namespace binding required. */
export const achievementsClientLayerWithoutDependencies = Layer.effect(
  Achievements,
  makeAchievementsClient,
);

/** Layer that provides the achievements client and registers its `AchievementsDO` server. */
export const achievementsClientLayer = achievementsClientLayerWithoutDependencies.pipe(
  Layer.provide(achievementsServerLayer),
);
