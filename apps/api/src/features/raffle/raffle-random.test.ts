import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { RaffleRandom, raffleRandomLayer } from "./raffle-random.ts";

it.effect("Web Crypto rejection sampling draws only inclusive integer raffle numbers", () =>
  Effect.gen(function* () {
    const random = yield* RaffleRandom;
    const draws = yield* Effect.all(Array.from({ length: 10_000 }, () => random.drawNumber()));

    for (const draw of draws) {
      expect(Number.isInteger(draw)).toBe(true);
      expect(draw).toBeGreaterThanOrEqual(1);
      expect(draw).toBeLessThanOrEqual(10_000);
    }

    // This catches a broken constant entropy source without making statistical uniformity claims.
    expect(new Set(draws).size).toBeGreaterThan(1);
  }).pipe(Effect.provide(raffleRandomLayer)),
);
