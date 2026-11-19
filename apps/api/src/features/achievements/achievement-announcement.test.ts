import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { ProviderError } from "@cf-twitch/contracts/provider";
import { decideAchievementAnnouncement } from "./achievement-announcement.ts";

const providerFailure = (kind: ProviderError["kind"], retryAfterMs = Option.none<number>()) =>
  new ProviderError({
    provider: "twitch",
    operation: "sendChatMessage",
    kind,
    status: 0,
    retryAfterMs,
  });

it.prop(
  "unknown chat outcomes never retry regardless of attempts or advertised provider delay",
  [
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 })),
  ],
  ([attempts, delay]) => {
    expect(
      decideAchievementAnnouncement({
        error: providerFailure("outcome-unknown", Option.some(delay)),
        attempts,
        nowMs: 0,
      }),
    ).toEqual({ state: "uncertain", attempts });
  },
  { arbitrary: { runs: 200, seed: 122 } },
);

it("definite refusals retain the three-delay retry budget", () => {
  for (const [attempts, delay] of [3_000, 5_000, 10_000].entries()) {
    expect(
      decideAchievementAnnouncement({
        error: providerFailure("rate-limited"),
        attempts,
        nowMs: 1_000,
      }),
    ).toEqual({ state: "pending", attempts: attempts + 1, nextAttemptAt: 1_000 + delay });
  }

  expect(
    decideAchievementAnnouncement({
      error: providerFailure("rate-limited"),
      attempts: 3,
      nowMs: 0,
    }),
  ).toEqual({ state: "abandoned", attempts: 3 });
});

it.prop(
  "definite refusals within the retry budget respect longer Retry-After",
  [
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    Schema.Int.check(Schema.isBetween({ minimum: 10_000, maximum: 86_400_000 })),
  ],
  ([attempts, delay]) => {
    expect(
      decideAchievementAnnouncement({
        error: providerFailure("rate-limited", Option.some(delay)),
        attempts,
        nowMs: 1_000,
      }),
    ).toEqual({ state: "pending", attempts: attempts + 1, nextAttemptAt: 1_000 + delay });
  },
  { arbitrary: { runs: 100, seed: 19 } },
);

it("terminal rejected or dropped chat cannot become an automated duplicate attempt", () => {
  for (const kind of [
    "rejected",
    "chat-dropped",
    "invalid-input",
    "reauthorization-required",
  ] as const)
    expect(
      decideAchievementAnnouncement({ error: providerFailure(kind), attempts: 0, nowMs: 0 }),
    ).toEqual({ state: "abandoned", attempts: 0 });
});
