import { Context, Effect, Layer } from "effect";
import { RaffleError, RaffleNumber } from "@cf-twitch/contracts/raffle";

/** Cryptographic raffle draws are independent and uniform over the inclusive 1–10,000 range. */
export interface IRaffleRandom {
  readonly drawNumber: () => Effect.Effect<RaffleNumber, RaffleError>;
}
/** Randomness authority is separate from persisted one-roll-per-redemption policy. */
export class RaffleRandom extends Context.Service<RaffleRandom, IRaffleRandom>()(
  "@cf-twitch/RaffleRandom",
) {}
/** Rejects the incomplete final bucket of Uint32 values rather than introducing modulo bias. */
export const makeRaffleRandom = Effect.sync(() =>
  RaffleRandom.of({
    drawNumber: Effect.fn("RaffleRandom.drawNumber")(() =>
      Effect.try({
        try: () => {
          const upperBound = Math.floor(0x1_0000_0000 / 10_000) * 10_000;
          const words = new Uint32Array(1);
          while (true) {
            crypto.getRandomValues(words);
            const word = words[0];
            if (word !== undefined && word < upperBound)
              return RaffleNumber.make(1 + (word % 10_000));
          }
        },
        catch: () => new RaffleError({ operation: "drawNumber", reason: "randomness_unavailable" }),
      }),
    ),
  }),
);
/** Provides Web Crypto rejection sampling; never Effect's deterministic pseudo-random generator. */
export const raffleRandomLayer = Layer.effect(RaffleRandom, makeRaffleRandom);
