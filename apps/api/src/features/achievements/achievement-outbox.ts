import { Context, DateTime, Effect, Layer, Option, Schema, SynchronizedRef } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import {
  AchievementCategory,
  AchievementError,
  AchievementId,
  type AchievementOperation,
  type UnannouncedAchievement,
  achievementErrorWithoutIdentifiers,
} from "@cf-twitch/contracts/achievement";
import { IsoTimestamp, ViewerId } from "@cf-twitch/contracts/identity";
import { ChatMessageText, ProviderError } from "@cf-twitch/contracts/provider";
import { TwitchService } from "../providers/twitch-service.ts";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { Achievements, achievementsLayer, achievementsTestLayer } from "./achievements-service.ts";
import { decideAchievementAnnouncement } from "./achievement-announcement.ts";
import { twitchServiceTestLayer } from "../providers/twitch-service.ts";
import { twitchAnalyticsTestLayer } from "../../runtime/twitch-analytics.ts";

/** Unlock delivery that owns atomic metric and announcement claims and durable retry state, not achievement progression. */
export interface IAchievementOutbox {
  /**
   * Delivers pending unlock metrics and chat announcements, at most one hundred unlocks per call.
   *
   * **Details**
   *
   * Each metric and announcement is claimed before it is sent, so concurrent flushes deliver once.
   * Failed announcements are retried, abandoned, or marked uncertain by `decideAchievementAnnouncement`;
   * an unknown chat outcome is never retried.
   *
   * @returns Nothing. Fails with `AchievementError` (`flushUnlockEffects`) `invalid_stored_data` when a
   *   stored intent fails validation, or `persistence_unavailable` when storage fails. Deliveries
   *   claimed before the failure keep their recorded state.
   */
  readonly flush: () => Effect.Effect<void, AchievementError>;
  /**
   * Returns whether any unlock metric or announcement still awaits delivery.
   *
   * @returns Whether work is pending. Fails with `AchievementError` (`hasPendingUnlockEffects`)
   *   `invalid_stored_data` or `persistence_unavailable`.
   */
  readonly hasPending: () => Effect.Effect<boolean, AchievementError>;
}

/** Service that delivers achievement unlock metrics and chat announcements from durable intents. */
export class AchievementOutbox extends Context.Service<AchievementOutbox, IAchievementOutbox>()(
  "@cf-twitch/AchievementOutbox",
) {}

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

/** `COUNT(*)` always returns exactly one row. */
const parsePendingCount = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ count: Schema.Int })]),
);

const refineAchievementAnnouncementText = Schema.decodeEffect(ChatMessageText);

const translateAchievementOutboxErrors =
  (operation: AchievementOperation) =>
  <A>(
    effect: Effect.Effect<A, Schema.SchemaError | SqlError.SqlError>,
  ): Effect.Effect<A, AchievementError> =>
    effect.pipe(
      Effect.catchTags({
        SchemaError: () =>
          Effect.fail(
            new AchievementError({
              operation,
              reason: "invalid_stored_data",
              ...achievementErrorWithoutIdentifiers,
            }),
          ),
        SqlError: () =>
          Effect.fail(
            new AchievementError({
              operation,
              reason: "persistence_unavailable",
              ...achievementErrorWithoutIdentifiers,
            }),
          ),
      }),
    );

/** Unlock details an announcement and its metric need. */
interface AchievementUnlockDelivery {
  /** Delivery identity reported with the metric. */
  readonly effectId: string;
  readonly userDisplayName: string;
  readonly achievementId: AchievementId;
  readonly achievementName: string;
  readonly achievementDescription: string;
  readonly category: AchievementCategory;
}

/**
 * Sends one unlock announcement to Twitch chat.
 *
 * @returns Nothing. Fails with `ProviderError` `invalid-input` before any Twitch request when the text
 *   exceeds a chat message, or with the `ProviderError` Twitch chat delivery reports.
 */
const sendAchievementAnnouncement = Effect.fn("AchievementOutbox.sendAnnouncement")(function* (
  twitch: TwitchService["Service"],
  unlock: AchievementUnlockDelivery,
) {
  const message = yield* refineAchievementAnnouncementText(
    `🏆 @${unlock.userDisplayName} unlocked "${unlock.achievementName}"! ${unlock.achievementDescription}`,
  ).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new ProviderError({
          provider: "twitch",
          operation: "sendChatMessage",
          reason: "invalid-input",
          status: Option.none(),
          retryAfterMs: Option.none(),
        }),
      ),
    ),
  );

  yield* twitch.sendChatMessage({ message });
});

/** Writes the analytics metric for one unlock; metric delivery is best effort and never fails. */
const writeAchievementUnlockMetric = (
  analytics: TwitchAnalytics["Service"],
  unlock: AchievementUnlockDelivery,
) =>
  analytics.writeAchievementUnlockMetric({
    effectId: unlock.effectId,
    user: unlock.userDisplayName,
    achievementId: unlock.achievementId,
    achievementName: unlock.achievementName,
    category: unlock.category,
  });

/**
 * Effect that builds the SQL unlock outbox after the achievement authority has migrated and recovered.
 *
 * **Details**
 *
 * Twitch chat has no idempotency key or reconciliation API, so a claimed announcement is never sent
 * twice; a lost completion leaves it `uncertain` after recovery.
 *
 * @returns The outbox; building it cannot fail beyond the `Achievements` authority it waits for.
 */
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

      if (metricClaim.length > 0) yield* writeAchievementUnlockMetric(analytics, effect);

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
          reason: error.reason,
          state: decision.state,
          attempts: decision.attempts,
        });
      });

      yield* sendAchievementAnnouncement(twitch, effect).pipe(
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
  }, translateAchievementOutboxErrors("flushUnlockEffects"));

  return AchievementOutbox.of({
    flush,
    hasPending: Effect.fn("AchievementOutbox.hasPending")(function* () {
      const [pending] = yield* parsePendingCount(
        yield* sql`SELECT COUNT(*) count FROM achievement_unlock_outbox WHERE metric_state='pending' OR announcement_state='pending'`,
      );

      return pending.count > 0;
    }, translateAchievementOutboxErrors("hasPendingUnlockEffects")),
  });
});

/** Layer that provides the SQL unlock outbox while leaving the achievement authority, SQL, Twitch, and analytics required. */
export const achievementOutboxLayerWithoutDependencies = Layer.effect(
  AchievementOutbox,
  makeAchievementOutbox,
);

/**
 * Production Layer for the SQL unlock outbox with the SQL achievement authority selected.
 *
 * **Details**
 *
 * The Durable Object `SqlClient`, `TwitchService`, and `TwitchAnalytics` stay required: the
 * achievements server captures Twitch and analytics during outer initialization and supplies all
 * three in its runtime phase. Merging this Layer with `achievementsLayer` shares one authority.
 */
export const achievementOutboxLayer = achievementOutboxLayerWithoutDependencies.pipe(
  Layer.provide(achievementsLayer),
);

/** Delivery state the in-memory outbox keeps for one unlock. */
interface InMemoryAchievementDelivery {
  readonly metricClaimed: boolean;
  readonly announcementState: "pending" | "sending" | "sent" | "abandoned" | "uncertain";
  readonly announcementAttempts: number;
  /** Earliest retry time in epoch milliseconds, or `None` when the announcement may be sent now. */
  readonly nextAttemptAt: Option.Option<number>;
}

const newInMemoryAchievementDelivery: InMemoryAchievementDelivery = {
  metricClaimed: false,
  announcementState: "pending",
  announcementAttempts: 0,
  nextAttemptAt: Option.none(),
};

const inMemoryAchievementDeliveryKey = (unlock: UnannouncedAchievement) =>
  `${unlock.userDisplayName}:${unlock.achievement.id}:${unlock.achievement.unlockedAt}`;

/**
 * Effect that builds an in-memory unlock outbox over the `Achievements` interface.
 *
 * **Details**
 *
 * It discovers unlocks through `getUnannounced`, claims each metric and announcement once, and applies
 * the production retry decision. Claims are serialized through one synchronized state, so concurrent
 * flushes still deliver once.
 *
 * @returns The outbox; building it cannot fail. Its methods fail only with the `AchievementError`
 *   that `getUnannounced` reports.
 */
const makeInMemoryAchievementOutbox = Effect.gen(function* () {
  const achievements = yield* Achievements;
  const twitch = yield* TwitchService;
  const analytics = yield* TwitchAnalytics;

  const deliveries = yield* SynchronizedRef.make<ReadonlyMap<string, InMemoryAchievementDelivery>>(
    new Map(),
  );

  const readDelivery = (
    current: ReadonlyMap<string, InMemoryAchievementDelivery>,
    key: string,
  ): InMemoryAchievementDelivery =>
    Option.getOrElse(
      Option.fromUndefinedOr(current.get(key)),
      () => newInMemoryAchievementDelivery,
    );

  /** Atomically applies `change` to one delivery; `None` leaves it unchanged and reports no claim. */
  const claimDelivery = <A>(
    key: string,
    change: (
      delivery: InMemoryAchievementDelivery,
    ) => Option.Option<readonly [A, InMemoryAchievementDelivery]>,
  ) =>
    SynchronizedRef.modify(deliveries, (current) =>
      Option.match(change(readDelivery(current, key)), {
        onNone: () => [Option.none<A>(), current] as const,
        onSome: ([claimed, next]) =>
          [Option.some(claimed), new Map(current).set(key, next)] as const,
      }),
    );

  const deliver = Effect.fn("InMemoryAchievementOutbox.deliver")(function* (
    unlock: UnannouncedAchievement,
  ) {
    const key = inMemoryAchievementDeliveryKey(unlock);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);

    const delivery: AchievementUnlockDelivery = {
      effectId: key,
      userDisplayName: unlock.userDisplayName,
      achievementId: unlock.achievement.id,
      achievementName: unlock.achievement.name,
      achievementDescription: unlock.achievement.description,
      category: unlock.achievement.category,
    };

    const metricClaim = yield* claimDelivery(key, (current) =>
      current.metricClaimed
        ? Option.none()
        : Option.some([true, { ...current, metricClaimed: true }] as const),
    );

    if (Option.isSome(metricClaim)) yield* writeAchievementUnlockMetric(analytics, delivery);

    const announcementClaim = yield* claimDelivery(key, (current) =>
      current.announcementState !== "pending" ||
      Option.exists(current.nextAttemptAt, (nextAttemptAt) => nextAttemptAt > nowMs)
        ? Option.none()
        : Option.some([
            current.announcementAttempts,
            { ...current, announcementState: "sending" },
          ] as const),
    );

    if (Option.isNone(announcementClaim)) return;

    const recordOutcome = (
      outcome: Pick<
        InMemoryAchievementDelivery,
        "announcementState" | "announcementAttempts" | "nextAttemptAt"
      >,
    ) => claimDelivery(key, (current) => Option.some([true, { ...current, ...outcome }] as const));

    yield* sendAchievementAnnouncement(twitch, delivery).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          recordOutcome({
            announcementState: "sent",
            announcementAttempts: announcementClaim.value,
            nextAttemptAt: Option.none(),
          }),
        onFailure: (error) =>
          Effect.flatMap(DateTime.now, (failedAt) => {
            const decision = decideAchievementAnnouncement({
              error,
              attempts: announcementClaim.value,
              nowMs: DateTime.toEpochMillis(failedAt),
            });

            return recordOutcome({
              announcementState: decision.state,
              announcementAttempts: decision.attempts,
              nextAttemptAt:
                decision.state === "pending" ? Option.some(decision.nextAttemptAt) : Option.none(),
            });
          }),
      }),
    );
  });

  return AchievementOutbox.of({
    flush: Effect.fn("InMemoryAchievementOutbox.flush")(function* () {
      const unlocks = yield* achievements.getUnannounced();

      yield* Effect.forEach(unlocks.slice(0, 100), deliver, { discard: true });
    }),
    hasPending: Effect.fn("InMemoryAchievementOutbox.hasPending")(function* () {
      const unlocks = yield* achievements.getUnannounced();
      const current = yield* SynchronizedRef.get(deliveries);

      return unlocks.some((unlock) => {
        const delivery = readDelivery(current, inMemoryAchievementDeliveryKey(unlock));

        return !delivery.metricClaimed || delivery.announcementState === "pending";
      });
    }),
  });
});

/**
 * Layer that provides the in-memory unlock outbox, leaving the achievement authority, Twitch service
 * and analytics required.
 *
 * **When to use**
 *
 * Use when a test selects a controlled Twitch provider mode for the in-memory outbox.
 *
 * **Details**
 *
 * Because the in-memory authority keeps every unlock pending announcement, sent unlocks remain
 * listed by `getUnannounced`; the outbox tracks their delivery itself.
 */
export const achievementOutboxInMemoryLayerWithoutDependencies = Layer.effect(
  AchievementOutbox,
  makeInMemoryAchievementOutbox,
);

/**
 * Test Layer that provides an in-memory unlock outbox over the in-memory achievement authority.
 *
 * **Details**
 *
 * Uses the Twitch service and analytics test Layers; `HttpClient` stays visible so each test
 * selects a controlled Helix transport. Merge this Layer with `achievementsTestLayer` to share one
 * authority.
 */
export const achievementOutboxTestLayer = achievementOutboxInMemoryLayerWithoutDependencies.pipe(
  Layer.provide([achievementsTestLayer, twitchServiceTestLayer, twitchAnalyticsTestLayer]),
);
