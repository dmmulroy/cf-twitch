import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect, Option, Schema } from "effect";
import { ChannelPointRedemption } from "@cf-twitch/contracts/redemption";
import { WorkflowLookup } from "@cf-twitch/contracts/workflow";
import { WorkflowAlarm, workflowAlarmTestLayer } from "./workflow-alarm.ts";
import { WorkflowStarters, workflowStartersTestLayer } from "./workflow-starters.ts";

const redemption = Schema.decodeUnknownSync(ChannelPointRedemption)({
  id: "redemption-1",
  broadcasterId: "broadcaster",
  userId: "viewer",
  userLogin: "viewer",
  userDisplayName: "Viewer",
  userInput: "spotify:track:abc",
  reward: { id: "reward", title: "Song", cost: 100, prompt: "" },
  redeemedAt: "2026-01-01T00:00:00Z",
});

const songLookup = WorkflowLookup.cases.SongRequest.make({ redemptionId: redemption.id });

describe("workflowStartersTestLayer honors the durable start contract", () => {
  it.effect("records a started run as RUNNING under its deterministic identity", () =>
    Effect.gen(function* () {
      const starters = yield* WorkflowStarters;

      expect(yield* starters.getStatus(songLookup)).toEqual(Option.none());
      yield* starters.startSongRequest(redemption);

      expect(yield* starters.getStatus(songLookup)).toMatchObject({
        value: { sagaId: "redemption-1", status: "RUNNING" },
      });
      // The same redemption ID in another workflow namespace is a different run.
      expect(
        yield* starters.getStatus(
          WorkflowLookup.cases.KeyboardRaffle.make({ redemptionId: redemption.id }),
        ),
      ).toEqual(Option.none());
    }).pipe(Effect.provide(workflowStartersTestLayer)),
  );

  it.effect("accepts an identical restart but rejects changed input for the same identity", () =>
    Effect.gen(function* () {
      const starters = yield* WorkflowStarters;
      yield* starters.startSongRequest(redemption);
      yield* starters.startSongRequest(redemption);

      const changed = yield* starters
        .startSongRequest({ ...redemption, userInput: "spotify:track:other" })
        .pipe(Effect.result);

      expect(changed).toHaveProperty("failure._tag", "WorkflowError");
      expect(changed).toMatchObject({ failure: { operation: "initialize", reason: "conflict" } });
    }).pipe(Effect.provide(workflowStartersTestLayer)),
  );
});

describe("workflowAlarmTestLayer holds one pending wake-up like a Durable Object", () => {
  it.effect("replaces the scheduled time and clears it on cancellation", () =>
    Effect.gen(function* () {
      const alarm = yield* WorkflowAlarm;

      expect(yield* alarm.get()).toEqual(Option.none());
      yield* alarm.set(Option.some(1_000));
      yield* alarm.set(Option.some(2_000));
      expect(yield* alarm.get()).toEqual(Option.some(2_000));
      yield* alarm.set(Option.none());
      expect(yield* alarm.get()).toEqual(Option.none());
    }).pipe(Effect.provide(workflowAlarmTestLayer)),
  );
});
