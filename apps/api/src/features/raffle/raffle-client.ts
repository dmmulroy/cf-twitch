import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { RaffleError } from "@cf-twitch/contracts/raffle";
import { Raffle } from "./raffle-service.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";
import raffleServerLayer, { RaffleServer } from "./raffle-server.ts";

type RaffleClientError = RaffleError | HttpClientError.HttpClientError | Schema.SchemaError;

const translateRaffleClientErrors =
  (operation: string) =>
  <A>(effect: Effect.Effect<A, RaffleClientError>): Effect.Effect<A, RaffleError> =>
    effect.pipe(
      Effect.catchTags({
        RaffleError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(new RaffleError({ operation, reason: "transport_unavailable" })),
        SchemaError: () => Effect.fail(new RaffleError({ operation, reason: "invalid_response" })),
      }),
    );

/** Creates a singleton HTTP client per execution, never retaining invocation-scoped stubs globally. */
export const makeRaffleClient = Effect.gen(function* () {
  const namespace = yield* RaffleServer;
  const client = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(RaffleHttpApi, {
        baseUrl: "http://raffle.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName("keyboard-raffle")),
      }),
    ),
  );
  return Raffle.of({
    recordRoll: Effect.fn("RaffleClient.recordRoll")(function* (input) {
      const http = yield* client;
      return yield* http.raffle
        .recordRoll({ payload: input })
        .pipe(translateRaffleClientErrors("recordRoll"));
    }),
    getOrCreateRoll: Effect.fn("RaffleClient.getOrCreateRoll")(function* (input) {
      const http = yield* client;
      return yield* http.raffle
        .getOrCreateRoll({ payload: input })
        .pipe(translateRaffleClientErrors("getOrCreateRoll"));
    }),
    deleteRollById: Effect.fn("RaffleClient.deleteRollById")(function* (input) {
      const http = yield* client;
      return yield* http.raffle
        .deleteRollById({ payload: input })
        .pipe(translateRaffleClientErrors("deleteRollById"));
    }),
    getLeaderboard: Effect.fn("RaffleClient.getLeaderboard")(function* (input) {
      const http = yield* client;
      return yield* http.raffle
        .getLeaderboard({ payload: input })
        .pipe(translateRaffleClientErrors("getLeaderboard"));
    }),
    getUserStats: Effect.fn("RaffleClient.getUserStats")(function* (input) {
      const http = yield* client;
      return yield* http.raffle
        .getUserStats({ payload: input })
        .pipe(translateRaffleClientErrors("getUserStats"));
    }),
    getUserStatsByDisplayName: Effect.fn("RaffleClient.getUserStatsByDisplayName")(
      function* (input) {
        const http = yield* client;
        return yield* http.raffle
          .getUserStatsByDisplayName({ payload: input })
          .pipe(translateRaffleClientErrors("getUserStatsByDisplayName"));
      },
    ),
    getClosestRecord: Effect.fn("RaffleClient.getClosestRecord")(function* () {
      const http = yield* client;
      return yield* http.raffle
        .getClosestRecord()
        .pipe(translateRaffleClientErrors("getClosestRecord"));
    }),
  });
});
/** Provides the raffle client while leaving namespace binding selection explicit. */
export const raffleClientLayerWithoutDependencies = Layer.effect(Raffle, makeRaffleClient);
/** Provides the raffle client and its physical Durable Object server. */
export const raffleClientLayer = raffleClientLayerWithoutDependencies.pipe(
  Layer.provide(raffleServerLayer),
);
