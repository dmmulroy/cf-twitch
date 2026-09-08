import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import {
  AchievementCategory,
  AchievementError,
  AchievementId,
} from "@cf-twitch/contracts/achievement";
import { IsoTimestamp, ViewerId } from "@cf-twitch/contracts/identity";
import { ChatMessageText, ProviderError } from "@cf-twitch/contracts/provider";
import { TwitchService } from "../providers/twitch-service.ts";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { Achievements } from "./achievements-service.ts";
import { decideAchievementAnnouncement } from "./achievement-announcement.ts";

const StoredUnlockEffect = Schema.Struct({
  effectId: Schema.NonEmptyString,
  eventId: Schema.String,
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  achievementId: AchievementId,
  achievementName: Schema.NonEmptyString,
  achievementDescription: Schema.NonEmptyString,
  category: AchievementCategory,
  metricState: Schema.Literals(["pending", "claimed"]),
  announcementState: Schema.Literals(["pending", "sending", "sent", "abandoned", "uncertain"]),
  announcementAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
const parseUnlockEffects = Schema.decodeUnknownEffect(Schema.Array(StoredUnlockEffect));
const parseClaims = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ effectId: Schema.String })),
);
const parsePendingCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Int })),
);
const refineAchievementAnnouncementText = Schema.decodeEffect(ChatMessageText);
const outboxFailure = (operation: string) =>
  Effect.mapError(
    (error: Schema.SchemaError | SqlError.SqlError) =>
      new AchievementError({
        operation,
        reason: error._tag === "SchemaError" ? "invalid_stored_data" : "persistence_unavailable",
      }),
  );

/** Unlock delivery owns atomic claims and durable retry state, not achievement progression. */
export interface IAchievementOutbox {
  readonly flush: () => Effect.Effect<void, AchievementError>;
  readonly hasPending: () => Effect.Effect<boolean, AchievementError>;
}
/** Transactional achievement unlock outbox delivery capability. */
export class AchievementOutbox extends Context.Service<AchievementOutbox, IAchievementOutbox>()(
  "@cf-twitch/AchievementOutbox",
) {}
/** Acquire delivery after SQL recovery; Twitch chat has no idempotency key or reconciliation API. */
export const makeAchievementOutbox = Effect.gen(function* () {
  yield* Achievements; // Enforces completed migrations before touching the outbox.
  const sql = yield* SqlClient.SqlClient;
  const twitch = yield* TwitchService;
  const analytics = yield* TwitchAnalytics;
  const flush = Effect.fn("AchievementOutbox.flush")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const timestamp = DateTime.formatIso(now);
    const rows = yield* parseUnlockEffects(
      yield* sql`SELECT effect_id AS effectId,event_id AS eventId,user_id AS userId,user_display_name AS userDisplayName,achievement_id AS achievementId,achievement_name AS achievementName,achievement_description AS achievementDescription,category,metric_state AS metricState,announcement_state AS announcementState,announcement_attempts AS announcementAttempts,created_at AS createdAt,updated_at AS updatedAt FROM achievement_unlock_outbox WHERE metric_state='pending' OR (announcement_state='pending' AND effect_id NOT IN (SELECT effect_id FROM achievement_outbox_retry WHERE next_attempt_at>${nowMs})) ORDER BY created_at,effect_id LIMIT 100`,
    );
    for (const effect of rows) {
      const metricClaim = yield* parseClaims(
        yield* sql`UPDATE achievement_unlock_outbox SET metric_state='claimed',updated_at=${timestamp} WHERE effect_id=${effect.effectId} AND metric_state='pending' RETURNING effect_id AS effectId`,
      );
      if (metricClaim.length > 0)
        yield* analytics.writeAchievementUnlockMetric({
          effectId: effect.effectId,
          user: effect.userDisplayName,
          achievementId: effect.achievementId,
          achievementName: effect.achievementName,
          category: effect.category,
        });
      const claim = yield* parseClaims(
        yield* sql`UPDATE achievement_unlock_outbox SET announcement_state='sending',updated_at=${timestamp} WHERE effect_id=${effect.effectId} AND announcement_state='pending' AND effect_id NOT IN (SELECT effect_id FROM achievement_outbox_retry WHERE next_attempt_at>${nowMs}) RETURNING effect_id AS effectId`,
      );
      if (claim.length === 0) continue;
      const recordFailure = Effect.fn("AchievementOutbox.recordFailure")(function* (
        error: ProviderError,
      ) {
        const failedAt = yield* DateTime.now;
        const decision = decideAchievementAnnouncement({
          error,
          attempts: effect.announcementAttempts,
          nowMs: DateTime.toEpochMillis(failedAt),
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE achievement_unlock_outbox SET announcement_state=${decision.state},announcement_attempts=${decision.attempts},updated_at=${DateTime.formatIso(failedAt)} WHERE effect_id=${effect.effectId} AND announcement_state='sending'`;
            if (decision.state === "pending")
              yield* sql`INSERT INTO achievement_outbox_retry(effect_id,next_attempt_at) VALUES (${effect.effectId},${decision.nextAttemptAt}) ON CONFLICT(effect_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at`;
          }),
        );
        yield* Effect.logWarning("Achievement announcement delivery failed", {
          effectId: effect.effectId,
          kind: error.kind,
          state: decision.state,
          attempts: decision.attempts,
        });
      });
      const sendAnnouncement = Effect.gen(function* () {
        const message = yield* refineAchievementAnnouncementText(
          `🏆 @${effect.userDisplayName} unlocked "${effect.achievementName}"! ${effect.achievementDescription}`,
        ).pipe(
          Effect.mapError(
            () =>
              new ProviderError({
                provider: "twitch",
                operation: "sendChatMessage",
                kind: "invalid-input",
                status: 0,
                retryAfterMs: Option.none(),
              }),
          ),
        );
        yield* twitch.sendChatMessage({ message });
      });
      yield* sendAnnouncement.pipe(
        Effect.matchEffect({
          onFailure: recordFailure,
          onSuccess: () =>
            sql.withTransaction(
              Effect.gen(function* () {
                const sent = yield* parseClaims(
                  yield* sql`UPDATE achievement_unlock_outbox SET announcement_state='sent',updated_at=${timestamp} WHERE effect_id=${effect.effectId} AND announcement_state='sending' RETURNING effect_id AS effectId`,
                );
                // A session reset or administrative reset may have replaced this unlock while HTTP was in flight.
                if (sent.length > 0)
                  yield* sql`UPDATE user_achievements SET announcement_state='sent' WHERE user_id=${effect.userId} AND achievement_id=${effect.achievementId} AND EXISTS (SELECT 1 FROM achievement_current_unlock c WHERE c.user_id=user_achievements.user_id AND c.achievement_id=user_achievements.achievement_id AND c.effect_id=${effect.effectId})`;
                yield* sql`DELETE FROM achievement_outbox_retry WHERE effect_id=${effect.effectId}`;
              }),
            ),
        }),
      );
    }
  }, outboxFailure("flushUnlockEffects"));
  return AchievementOutbox.of({
    flush,
    hasPending: Effect.fn("AchievementOutbox.hasPending")(function* () {
      const rows = yield* parsePendingCount(
        yield* sql`SELECT COUNT(*) count FROM achievement_unlock_outbox WHERE metric_state='pending' OR announcement_state='pending'`,
      );
      return (rows[0]?.count ?? 0) > 0;
    }, outboxFailure("hasPendingUnlockEffects")),
  });
});
/** Outbox requires real Twitch and analytics capabilities; no production fallback is substituted. */
export const achievementOutboxLayerWithoutDependencies = Layer.effect(
  AchievementOutbox,
  makeAchievementOutbox,
);
