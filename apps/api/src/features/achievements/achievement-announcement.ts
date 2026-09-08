import { Option } from "effect";
import type { ProviderError } from "@cf-twitch/contracts/provider";

/** Only a definite refusal or preflight failure carries a safe retry instant. */
export type AchievementAnnouncementDecision =
  | { readonly state: "uncertain" | "abandoned"; readonly attempts: number }
  | { readonly state: "pending"; readonly attempts: number; readonly nextAttemptAt: number };

const announcementRetryDelaysMs = [3_000, 5_000, 10_000] as const;

/** Unknown chat outcomes are terminal; known-safe retries retain the historical three-delay budget. */
export function decideAchievementAnnouncement(input: {
  readonly error: ProviderError;
  readonly attempts: number;
  readonly nowMs: number;
}): AchievementAnnouncementDecision {
  if (input.error.kind === "outcome-unknown")
    return { state: "uncertain", attempts: input.attempts };
  const delay = announcementRetryDelaysMs[input.attempts];
  const retryable = ["network", "rate-limited", "offline", "persistence"].includes(
    input.error.kind,
  );
  if (!retryable || delay === undefined) return { state: "abandoned", attempts: input.attempts };
  return {
    state: "pending",
    attempts: input.attempts + 1,
    nextAttemptAt:
      input.nowMs +
      Math.max(
        delay,
        Option.getOrElse(input.error.retryAfterMs, () => 0),
      ),
  };
}
