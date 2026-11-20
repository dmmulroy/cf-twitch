import { Cause, Context, Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  RaffleError,
  RaffleNumber,
  raffleErrorWithoutIdentifiers,
} from "@cf-twitch/contracts/raffle";

/** Largest multiple of 10,000 at or below 2^32; words at or above it are redrawn so no number is favored. */
const raffleRandomUpperBound = Math.floor(0x1_0000_0000 / 10_000) * 10_000;

/** Cryptographic Keyboard Raffle draws, independent and uniform over the inclusive 1–10,000 range. */
export interface IRaffleRandom {
  /**
   * Draws one Keyboard Raffle number by rejection sampling over 32-bit secure random words.
   *
   * @returns A uniform number from 1 through 10,000, or fails with `RaffleError` (`randomness_unavailable`)
   *   when the secure random primitive fails. Interruption is never converted into that failure.
   */
  readonly drawNumber: () => Effect.Effect<RaffleNumber, RaffleError>;
}

/** Service that draws Keyboard Raffle numbers from Effect `SecureRandom` bytes. */
export class RaffleRandom extends Context.Service<RaffleRandom, IRaffleRandom>()(
  "@cf-twitch/RaffleRandom",
) {}

/**
 * Effect that builds exact raffle draws from the `SecureRandom` service without swallowing interruption.
 *
 * @returns The draw service; building it cannot fail.
 */
export const makeRaffleRandom = Effect.gen(function* () {
  const secureRandom = yield* SecureRandom.SecureRandom;

  const drawNumber = Effect.fn("RaffleRandom.drawNumber")(
    function* () {
      while (true) {
        const bytes = yield* secureRandom.randomBytes(4);
        const word = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

        if (word < raffleRandomUpperBound) return RaffleNumber.make(1 + (word % 10_000));
      }
    },
    // SecureRandom reports an unavailable primitive as a defect; the raffle contract promises a typed failure.
    Effect.catchCauseIf(
      (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
      () =>
        Effect.fail(
          new RaffleError({
            operation: "drawNumber",
            reason: "randomness_unavailable",
            ...raffleErrorWithoutIdentifiers,
          }),
        ),
    ),
  );

  return RaffleRandom.of({ drawNumber });
});

/** Layer that provides raffle draws while leaving the platform `SecureRandom` service required. */
export const raffleRandomLayerWithoutDependencies = Layer.effect(RaffleRandom, makeRaffleRandom);

/**
 * Production Layer for raffle draws.
 *
 * **Details**
 *
 * `SecureRandom` is a Workers platform service: the outer composition root selects it and the
 * raffle server bridges it into the Durable Object runtime, so this Layer selects nothing further.
 */
export const raffleRandomLayer = raffleRandomLayerWithoutDependencies;

/** Seed of the deterministic test generator; any fixed value keeps test draws repeatable. */
const raffleRandomTestSeed = 0x5eed_2026;

/**
 * Deterministic `SecureRandom` for tests, using the mulberry32 generator.
 *
 * Its words are uniform but predictable, so the production rejection sampling stays exercised.
 */
const raffleRandomTestSecureRandomLayer = Layer.sync(SecureRandom.SecureRandom, () => {
  let state = raffleRandomTestSeed;

  const nextWord = (): number => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return (mixed ^ (mixed >>> 14)) >>> 0;
  };

  return SecureRandom.make((size) => {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);

    for (let offset = 0; offset < size; offset += 4) {
      const word = nextWord();

      for (let index = 0; index < 4 && offset + index < size; index++)
        view.setUint8(offset + index, (word >>> (24 - index * 8)) & 0xff);
    }

    return bytes;
  });
});

/** Test Layer that runs production raffle draws over a seeded, repeatable random sequence. */
export const raffleRandomTestLayer = raffleRandomLayerWithoutDependencies.pipe(
  Layer.provide(raffleRandomTestSecureRandomLayer),
);
