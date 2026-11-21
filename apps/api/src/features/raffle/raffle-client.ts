import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  RaffleError,
  type RaffleErrorIdentifiers,
  type RaffleOperation,
  raffleErrorIdentifiersForDisplayName,
  raffleErrorIdentifiersForRoll,
  raffleErrorIdentifiersForRollRemoval,
  raffleErrorIdentifiersForViewer,
  raffleErrorWithoutIdentifiers,
} from "@cf-twitch/contracts/raffle";
import { Raffle } from "./raffle-service.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";
import { RaffleServer, raffleServerLayer } from "./raffle-server.ts";

/**
 * Translates raffle HTTP client failures into `RaffleError`.
 *
 * A transport failure or unreadable response leaves a mutation's outcome unknown; the error message
 * directs callers to the idempotent retry each operation supports.
 *
 * @returns An `Effect.fn` transform whose effect fails only with `RaffleError`: the server's own
 *   `RaffleError` unchanged, `transport_unavailable` for `HttpClientError`, and `invalid_response`
 *   for `SchemaError`.
 */
const translateRaffleClientErrors =
  <Args extends ReadonlyArray<unknown>>(
    operation: RaffleOperation,
    identify: (...args: Args) => RaffleErrorIdentifiers,
  ) =>
  <A>(
    effect: Effect.Effect<A, RaffleError | HttpClientError.HttpClientError | Schema.SchemaError>,
    ...args: Args
  ): Effect.Effect<A, RaffleError> => {
    const identifiers = identify(...args);

    return effect.pipe(
      Effect.catchTags({
        RaffleError: (error) => Effect.fail(error),
        HttpClientError: () =>
          Effect.fail(
            new RaffleError({ operation, reason: "transport_unavailable", ...identifiers }),
          ),
        SchemaError: () =>
          Effect.fail(new RaffleError({ operation, reason: "invalid_response", ...identifiers })),
      }),
    );
  };

/**
 * Effect that builds the raffle client over the `KeyboardRaffleDO` namespace.
 *
 * **Details**
 *
 * One HTTP client is memoized per execution; invocation-scoped stubs are never retained globally.
 *
 * @returns The `Raffle` client; building it cannot fail. Its methods fail with the server's
 *   `RaffleError`, or with `transport_unavailable` or `invalid_response` when the server cannot be
 *   reached or understood.
 */
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
    recordRoll: Effect.fn("RaffleClient.recordRoll")(
      function* (input) {
        const http = yield* client;

        return yield* http.raffle.recordRoll({ payload: input });
      },
      translateRaffleClientErrors("recordRoll", raffleErrorIdentifiersForRoll),
    ),
    getOrCreateRoll: Effect.fn("RaffleClient.getOrCreateRoll")(
      function* (input) {
        const http = yield* client;

        return yield* http.raffle.getOrCreateRoll({ payload: input });
      },
      translateRaffleClientErrors("getOrCreateRoll", raffleErrorIdentifiersForRoll),
    ),
    deleteRollById: Effect.fn("RaffleClient.deleteRollById")(
      function* (input) {
        const http = yield* client;

        return yield* http.raffle.deleteRollById({ payload: input });
      },
      translateRaffleClientErrors("deleteRollById", raffleErrorIdentifiersForRollRemoval),
    ),
    getLeaderboard: Effect.fn("RaffleClient.getLeaderboard")(
      function* (input) {
        const http = yield* client;

        return yield* http.raffle.getLeaderboard({ payload: input });
      },
      translateRaffleClientErrors("getLeaderboard", () => raffleErrorWithoutIdentifiers),
    ),
    getUserStats: Effect.fn("RaffleClient.getUserStats")(
      function* (input) {
        const http = yield* client;

        return yield* http.raffle.getUserStats({ payload: input });
      },
      translateRaffleClientErrors("getUserStats", raffleErrorIdentifiersForViewer),
    ),
    getUserStatsByDisplayName: Effect.fn("RaffleClient.getUserStatsByDisplayName")(
      function* (input) {
        const http = yield* client;

        return yield* http.raffle.getUserStatsByDisplayName({ payload: input });
      },
      translateRaffleClientErrors(
        "getUserStatsByDisplayName",
        raffleErrorIdentifiersForDisplayName,
      ),
    ),
    getClosestRecord: Effect.fn("RaffleClient.getClosestRecord")(
      function* () {
        const http = yield* client;

        return yield* http.raffle.getClosestRecord();
      },
      translateRaffleClientErrors("getClosestRecord", () => raffleErrorWithoutIdentifiers),
    ),
  });
});

/** Layer that provides the raffle client while leaving the `KeyboardRaffleDO` namespace binding required. */
export const raffleClientLayerWithoutDependencies = Layer.effect(Raffle, makeRaffleClient);

/** Layer that provides the raffle client and registers its `KeyboardRaffleDO` server. */
export const raffleClientLayer = raffleClientLayerWithoutDependencies.pipe(
  Layer.provide(raffleServerLayer),
);
