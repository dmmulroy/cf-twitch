import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AchievementError } from "@cf-twitch/contracts/achievement";
import { Achievements } from "./achievements-service.ts";
import { AchievementsHttpApi } from "./achievements-http-api.ts";
import achievementsServerLayer, { AchievementsServer } from "./achievements-server.ts";

type AchievementsClientError =
  | AchievementError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

const translateAchievementsClientErrors =
  (operation: string) =>
  <A>(effect: Effect.Effect<A, AchievementsClientError>): Effect.Effect<A, AchievementError> =>
    effect.pipe(
      Effect.catchTags({
        AchievementError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(new AchievementError({ operation, reason: "transport_unavailable" })),
        SchemaError: () =>
          Effect.fail(new AchievementError({ operation, reason: "invalid_response" })),
      }),
    );

/** Creates a singleton HTTP client per execution, never retaining invocation-scoped stubs globally. */
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
    handleEvent: Effect.fn("AchievementsClient.handleEvent")(function* (input) {
      const http = yield* client;
      return yield* http.achievements
        .handleEvent({ payload: { event: input } })
        .pipe(translateAchievementsClientErrors("handleEvent"));
    }),
    recordEvent: Effect.fn("AchievementsClient.recordEvent")(function* (input) {
      const http = yield* client;
      return yield* http.achievements
        .recordEvent({ payload: input })
        .pipe(translateAchievementsClientErrors("recordEvent"));
    }),
    getDefinitions: Effect.fn("AchievementsClient.getDefinitions")(function* () {
      const http = yield* client;
      return yield* http.achievements
        .getDefinitions()
        .pipe(translateAchievementsClientErrors("getDefinitions"));
    }),
    getUserAchievements: Effect.fn("AchievementsClient.getUserAchievements")(function* (input) {
      const http = yield* client;
      return yield* http.achievements
        .getUserAchievements({ payload: input })
        .pipe(translateAchievementsClientErrors("getUserAchievements"));
    }),
    getUnlockedAchievements: Effect.fn("AchievementsClient.getUnlockedAchievements")(
      function* (input) {
        const http = yield* client;
        return yield* http.achievements
          .getUnlockedAchievements({ payload: input })
          .pipe(translateAchievementsClientErrors("getUnlockedAchievements"));
      },
    ),
    getLeaderboard: Effect.fn("AchievementsClient.getLeaderboard")(function* (input) {
      const http = yield* client;
      return yield* http.achievements
        .getLeaderboard({ payload: input })
        .pipe(translateAchievementsClientErrors("getLeaderboard"));
    }),
    getUnannounced: Effect.fn("AchievementsClient.getUnannounced")(function* () {
      const http = yield* client;
      return yield* http.achievements
        .getUnannounced()
        .pipe(translateAchievementsClientErrors("getUnannounced"));
    }),
    getDebugTableCounts: Effect.fn("AchievementsClient.getDebugTableCounts")(function* () {
      const http = yield* client;
      return yield* http.achievements
        .getDebugTableCounts()
        .pipe(translateAchievementsClientErrors("getDebugTableCounts"));
    }),
    getDebugUserSnapshot: Effect.fn("AchievementsClient.getDebugUserSnapshot")(function* (input) {
      const http = yield* client;
      return yield* http.achievements
        .getDebugUserSnapshot({ payload: input })
        .pipe(translateAchievementsClientErrors("getDebugUserSnapshot"));
    }),
    resetOneTimeAchievements: Effect.fn("AchievementsClient.resetOneTimeAchievements")(
      function* (input) {
        const http = yield* client;
        return yield* http.achievements
          .resetOneTimeAchievements({ payload: input })
          .pipe(translateAchievementsClientErrors("resetOneTimeAchievements"));
      },
    ),
  });
});
/** Provides the achievements client while leaving namespace binding selection explicit. */
export const achievementsClientLayerWithoutDependencies = Layer.effect(
  Achievements,
  makeAchievementsClient,
);
/** Provides the achievements client and its physical Durable Object server. */
export const achievementsClientLayer = achievementsClientLayerWithoutDependencies.pipe(
  Layer.provide(achievementsServerLayer),
);
