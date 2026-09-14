import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { FastCheck } from "effect/testing";
import {
  DomainEvent,
  encodeDomainEventJson,
  parseDomainEventJson,
  RaffleRollEvent,
} from "./domain-event.ts";
import { EventId, IsoTimestamp, RedemptionId, ViewerId } from "./identity.ts";
import { RaffleDistance, RaffleNumber } from "./raffle.ts";

const parseDomainEvent = Schema.decodeUnknownEffect(DomainEvent);

it("keeps durable JSON codecs unary and representation-specific", () => {
  expectTypeOf<Parameters<typeof parseDomainEventJson>>().toEqualTypeOf<[input: string]>();
  expectTypeOf<Parameters<typeof encodeDomainEventJson>>().toEqualTypeOf<[event: DomainEvent]>();
});

it.effect("rejects winner evidence that also claims a non-winning distance record", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      parseDomainEvent({
        id: "fa88369b-99df-44cd-8c79-c71bd4743fb6",
        v: 1,
        timestamp: "2026-09-05T12:00:00Z",
        type: "raffle_roll",
        source: "KeyboardRaffleSagaDO",
        userId: "viewer-123",
        userDisplayName: "Viewer",
        sagaId: "redemption-123",
        roll: 42,
        winningNumber: 42,
        distance: 0,
        isWinner: true,
        isNewRecord: true,
      }),
    );

    expect(error._tag).toBe("SchemaError");
  }),
);

it("preserves raffle evidence and optional correlation through durable JSON replay", () => {
  FastCheck.assert(
    FastCheck.property(
      Schema.toArbitrary(RaffleNumber)(FastCheck),
      Schema.toArbitrary(RaffleNumber)(FastCheck),
      FastCheck.boolean(),
      (roll, winningNumber, correlated) => {
        const event = RaffleRollEvent.make({
          id: EventId.make("fa88369b-99df-44cd-8c79-c71bd4743fb6"),
          v: 1,
          timestamp: IsoTimestamp.make("2026-09-05T12:00:00Z"),
          correlationId: correlated ? Option.some("delivery-123") : Option.none(),
          type: "raffle_roll",
          source: "KeyboardRaffleSagaDO",
          userId: ViewerId.make("viewer-123"),
          userDisplayName: "Viewer",
          sagaId: RedemptionId.make("redemption-123"),
          roll,
          winningNumber,
          distance: RaffleDistance.make(Math.abs(roll - winningNumber)),
          isWinner: roll === winningNumber,
          isNewRecord: false,
        });

        const replayed = Effect.runSync(
          Effect.gen(function* () {
            return yield* parseDomainEventJson(yield* encodeDomainEventJson(event));
          }),
        );

        expect(replayed).toEqual(event);
      },
    ),
    { numRuns: 100 },
  );
});
