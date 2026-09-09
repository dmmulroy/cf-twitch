import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
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

describe("Achievement rule properties", () => {
  it("threshold progress unlocks exactly at the threshold and never changes an existing unlock", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 1, max: 10_000 }),
        FastCheck.integer({ min: 0, max: 10_000 }),
        FastCheck.integer({ min: 1, max: 1_000 }),
        (threshold, progress, increment) => {
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
      ),
      { numRuns: 300, seed: 82019 },
    );
  });
  it("streak progress is replacement, never accumulated metadata increments", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: 1_000 }),
        FastCheck.integer({ min: 1, max: 1_000 }),
        (previous, current) => {
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
      ),
      { numRuns: 200, seed: 108 },
    );
  });
  it("stream watermark ordering is instant-based across offset representations", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: -720, max: 720 }), (offset) => {
        const shifted = new Date(Date.parse(timestamp) + offset * 60_000)
          .toISOString()
          .slice(0, -1);

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
      }),
      { numRuns: 200, seed: 729 },
    );
  });
});
