import { Array as EffectArray, Option } from "effect";
import type { ProviderError } from "@cf-twitch/contracts/provider";

/**
 * Next announcement state after a failed unlock announcement.
 *
 * Only a definite refusal or a failure before sending carries a retry instant; an unknown chat outcome
 * is `uncertain`, and an exhausted or non-retryable failure is `abandoned`.
 */
export type AchievementAnnouncementDecision =
  | {
      readonly state: "uncertain" | "abandoned";
      /** Announcement attempts recorded for the unlock, unchanged by a terminal decision. */
      readonly attempts: number;
    }
  | {
      readonly state: "pending";
      /** Announcement attempts recorded for the unlock, including the retry being scheduled. */
      readonly attempts: number;
      /** Earliest retry time in epoch milliseconds. */
      readonly nextAttemptAt: number;
    };

/** Historical retry budget: the delay before each of the three retries after a safe failure. */
const announcementRetryDelaysMs = [3_000, 5_000, 10_000] as const;

/** Failures that prove the chat message was not delivered, so a retry cannot duplicate it. */
const retryableAnnouncementFailures: ReadonlyArray<ProviderError["reason"]> = [
  "network",
  "rate-limited",
  "offline",
  "persistence",
];

/**
 * Decides whether a failed achievement announcement is retried, abandoned, or left uncertain.
 *
 * **Details**
 *
 * Twitch chat offers no idempotency key or reconciliation, so an unknown outcome is never retried.
 * Known-safe failures keep the historical budget of three retries after 3, 5, and 10 seconds, or
 * later when Twitch asks for a longer delay.
 */
export function decideAchievementAnnouncement(input: {
  readonly error: ProviderError;
  /** Announcement attempts already made for this unlock. */
  readonly attempts: number;
  /** Failure time in epoch milliseconds, from which the retry delay is measured. */
  readonly nowMs: number;
}): AchievementAnnouncementDecision {
  if (input.error.reason === "outcome-unknown")
    return { state: "uncertain", attempts: input.attempts };

  const delay = EffectArray.get(announcementRetryDelaysMs, input.attempts);

  if (!retryableAnnouncementFailures.includes(input.error.reason) || Option.isNone(delay))
    return { state: "abandoned", attempts: input.attempts };

  return {
    state: "pending",
    attempts: input.attempts + 1,
    nextAttemptAt:
      input.nowMs +
      Math.max(
        delay.value,
        Option.getOrElse(input.error.retryAfterMs, () => 0),
      ),
  };
}
