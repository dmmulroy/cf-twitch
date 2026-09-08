import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Raffle } from "./raffle-service.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";

/** HTTP handlers delegate to the instance-local raffle authority. */
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
