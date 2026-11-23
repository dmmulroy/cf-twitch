import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { AchievementDefinition, AchievementId } from "@cf-twitch/contracts/achievement";
import { EventId, IsoTimestamp, StreamId } from "@cf-twitch/contracts/identity";
import { StreamOnlineEvent } from "@cf-twitch/contracts/domain-event";
import { acceptsAchievementTransition, evaluateAchievementProgress } from "./achievement-rules.ts";

const timestamp = IsoTimestamp.make("2026-04-07T14:00:00.000Z");

const definition = (threshold: number) =>
  AchievementDefinition.make({
    id: AchievementId.make("threshold"),
    name: "Threshold",
    description: "Threshold unlock",
    icon: "1f3b5",
    category: "song_request",
    threshold: Option.some(threshold),
    triggerEvent: "song_request",
    scope: "cumulative",
  });

describe("Achievement stream watermark", () => {
  const restarted = (startedAt: string, streamId = "restarted") =>
    StreamOnlineEvent.make({
      id: EventId.make("00000000-0000-4000-8000-000000000002"),
      type: "stream_online",
      source: "StreamLifecycleDO",
      v: 1,
      timestamp: IsoTimestamp.make(startedAt),
      startedAt: IsoTimestamp.make(startedAt),
      streamId: StreamId.make(streamId),
      correlationId: Option.none(),
    });

  const ended = Option.some({
    status: "offline" as const,
    streamId: Option.some(StreamId.make("previous")),
    startedAt: Option.some(IsoTimestamp.make("2026-11-23T11:05:36Z")),
    transitionAt: IsoTimestamp.make("2026-11-23T13:07:37.835Z"),
  });

  it("orders online evidence after an ended session by that session's start", () => {
    expect(acceptsAchievementTransition(ended, restarted("2026-11-23T13:07:21Z"))).toBe(true);
    expect(acceptsAchievementTransition(ended, restarted("2026-11-23T11:05:36Z"))).toBe(false);
    expect(acceptsAchievementTransition(ended, restarted("2026-11-23T13:07:21Z", "previous"))).toBe(
      false,
    );
  });
});

describe("Achievement rule properties", () => {
  it.prop(
    "threshold progress unlocks exactly at the threshold and never changes an existing unlock",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    ],
    ([threshold, progress, increment]) => {
      const achievement = definition(threshold);

      const existing = {
        achievementId: achievement.id,
        progress,
        unlockedAt: Option.none<IsoTimestamp>(),
        eventId: Option.none<string>(),
      };

      const input = {
        definitions: [achievement],
        progress: new Map([[achievement.id, existing]]),
        trigger: {
          event: "song_request" as const,
          increment,
          mode: "increment" as const,
          eventId: "event",
        },
        now: timestamp,
        direct: false,
      };

      const decisions = evaluateAchievementProgress(input);
      expect(decisions[0]?.progress).toBe(progress + increment);
      expect(decisions[0]?.newlyUnlocked).toBe(progress + increment >= threshold);
      expect(
        evaluateAchievementProgress({
          ...input,
          progress: new Map([
            [achievement.id, { ...existing, unlockedAt: Option.some(timestamp) }],
          ]),
        }),
      ).toEqual([]);
    },
    { arbitrary: { runs: 300, seed: 82019 } },
  );
  it.prop(
    "streak progress is replacement, never accumulated metadata increments",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    ],
    ([previous, current]) => {
      const achievement = { ...definition(10_000), triggerEvent: "request_streak" as const };

      const decisions = evaluateAchievementProgress({
        definitions: [achievement],
        progress: new Map([
          [
            achievement.id,
            {
              achievementId: achievement.id,
              progress: previous,
              unlockedAt: Option.none(),
              eventId: Option.none(),
            },
          ],
        ]),
        trigger: {
          event: "request_streak",
          increment: current,
          mode: "set",
          eventId: "streak",
        },
        now: timestamp,
        direct: false,
      });

      expect(decisions[0]?.progress).toBe(current);
    },
    { arbitrary: { runs: 200, seed: 108 } },
  );
  it.prop(
    "stream watermark ordering is instant-based across offset representations",
    [Schema.Int.check(Schema.isBetween({ minimum: -720, maximum: 720 }))],
    ([offset]) => {
      const shifted = new Date(Date.parse(timestamp) + offset * 60_000).toISOString().slice(0, -1);

      const sign = offset >= 0 ? "+" : "-";
      const absolute = Math.abs(offset);

      const at = IsoTimestamp.make(
        `${shifted}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`,
      );

      const event = StreamOnlineEvent.make({
        id: EventId.make("00000000-0000-4000-8000-000000000001"),
        type: "stream_online",
        source: "StreamLifecycleDO",
        v: 1,
        timestamp: at,
        startedAt: at,
        streamId: StreamId.make("new"),
        correlationId: Option.none(),
      });

      expect(
        acceptsAchievementTransition(
          Option.some({
            status: "offline",
            streamId: Option.some(StreamId.make("old")),
            startedAt: Option.none(),
            transitionAt: timestamp,
          }),
          event,
        ),
      ).toBe(false);
    },
    { arbitrary: { runs: 200, seed: 729 } },
  );
});
