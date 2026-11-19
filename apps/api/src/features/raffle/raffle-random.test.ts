import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { RaffleError } from "@cf-twitch/contracts/raffle";
import { RaffleRandom, raffleRandomLayer } from "./raffle-random.ts";

const uint32Bytes = (word: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, word);

  return bytes;
};

const sequenceCryptoLayer = (words: ReadonlyArray<number>, onDraw?: () => void) => {
  let index = 0;

  return Layer.succeed(
    SecureRandom.SecureRandom,
    SecureRandom.make(() => {
      onDraw?.();
      const word = words[index++];

      if (word === undefined) throw new Error("Raffle test entropy sequence exhausted");

      return uint32Bytes(word);
    }),
  );
};

it.effect("rejects the incomplete uint32 bucket before accepting a raffle number", () => {
  let draws = 0;

  const layer = raffleRandomLayer.pipe(
    Layer.provide(sequenceCryptoLayer([0xffff_ffff, 0], () => draws++)),
  );

  return Effect.gen(function* () {
    const random = yield* RaffleRandom;
    expect(yield* random.drawNumber()).toBe(1);
    expect(draws).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("maps accepted uint32 boundary words to inclusive raffle bounds", () => {
  const largestAcceptedWord = Math.floor(0x1_0000_0000 / 10_000) * 10_000 - 1;

  const layer = raffleRandomLayer.pipe(
    Layer.provide(sequenceCryptoLayer([0, largestAcceptedWord])),
  );

  return Effect.gen(function* () {
    const random = yield* RaffleRandom;
    expect(yield* random.drawNumber()).toBe(1);
    expect(yield* random.drawNumber()).toBe(10_000);
  }).pipe(Effect.provide(layer));
});

it.effect("projects a throwing SecureRandom primitive as typed randomness unavailability", () => {
  const secureRandom = SecureRandom.make(() => {
    throw new Error("Controlled SecureRandom primitive failure");
  });

  return Effect.gen(function* () {
    const random = yield* RaffleRandom;
    expect(yield* random.drawNumber().pipe(Effect.flip)).toMatchObject(
      new RaffleError({
        operation: "drawNumber",
        reason: "randomness_unavailable",
      }),
    );
  }).pipe(
    Effect.provide(
      raffleRandomLayer.pipe(Layer.provide(Layer.succeed(SecureRandom.SecureRandom, secureRandom))),
    ),
  );
});

it.effect("preserves interruption from the SecureRandom byte source", () => {
  const base = SecureRandom.make(() => uint32Bytes(0));

  const secureRandom = SecureRandom.SecureRandom.of({
    ...base,
    randomBytes: () => Effect.interrupt,
  });

  return Effect.gen(function* () {
    const random = yield* RaffleRandom;
    const exit = yield* random.drawNumber().pipe(Effect.exit);

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  }).pipe(
    Effect.provide(
      raffleRandomLayer.pipe(Layer.provide(Layer.succeed(SecureRandom.SecureRandom, secureRandom))),
    ),
  );
});

it.effect("Effect Crypto rejection sampling draws only inclusive integer raffle numbers", () =>
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
  }).pipe(Effect.provide(raffleRandomLayer), Effect.provide(NodeCrypto.layer)),
);
