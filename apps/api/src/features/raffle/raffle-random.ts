import { Cause, Context, Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { RaffleError, RaffleNumber } from "@cf-twitch/contracts/raffle";

const raffleRandomUpperBound = Math.floor(0x1_0000_0000 / 10_000) * 10_000;

const randomnessUnavailable = () =>
  new RaffleError({ operation: "drawNumber", reason: "randomness_unavailable" });

/** Cryptographic raffle draws are independent and uniform over the inclusive 1–10,000 range. */
export interface IRaffleRandom {
  readonly drawNumber: () => Effect.Effect<RaffleNumber, RaffleError>;
}

/** Randomness authority retains exact raffle rejection sampling over Effect SecureRandom bytes. */
export class RaffleRandom extends Context.Service<RaffleRandom, IRaffleRandom>()(
  "@cf-twitch/RaffleRandom",
) {}

/** Constructs exact raffle draws from cryptographic bytes without swallowing interruption. */
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
    (effect) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
          () => Effect.fail(randomnessUnavailable()),
        ),
      ),
  );

  return RaffleRandom.of({ drawNumber });
});

/** Provides exact raffle rejection sampling while leaving platform SecureRandom selection explicit. */
export const raffleRandomLayer = Layer.effect(RaffleRandom, makeRaffleRandom);
