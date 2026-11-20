import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Raffle } from "./raffle-service.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";

/**
 * Layer of raffle HTTP handlers that delegate each endpoint to the instance-local `Raffle` authority.
 *
 * **Details**
 *
 * Each endpoint returns the service's `RaffleError` unchanged, encoded by the HTTP contract's error schema.
 */
export const raffleHttpHandlersLayer = HttpApiBuilder.group(RaffleHttpApi, "raffle", (handlers) =>
  Effect.gen(function* () {
    const service = yield* Raffle;

    return handlers
      .handle("recordRoll", ({ payload }) => service.recordRoll(payload))
      .handle("getOrCreateRoll", ({ payload }) => service.getOrCreateRoll(payload))
      .handle("deleteRollById", ({ payload }) => service.deleteRollById(payload))
      .handle("getLeaderboard", ({ payload }) => service.getLeaderboard(payload))
      .handle("getUserStats", ({ payload }) => service.getUserStats(payload))
      .handle("getUserStatsByDisplayName", ({ payload }) =>
        service.getUserStatsByDisplayName(payload),
      )
      .handle("getClosestRecord", () => service.getClosestRecord());
  }),
);
