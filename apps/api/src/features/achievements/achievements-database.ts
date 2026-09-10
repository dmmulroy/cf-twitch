import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type SqlError } from "effect/unstable/sql";
import {
  AchievementDefinition,
  AchievementError,
  AchievementEventInput,
  AchievementId,
  AchievementLeaderboardEntry,
  AchievementDebugEvent,
  UnlockedAchievement,
  type ViewerAchievementProgress,
} from "@cf-twitch/contracts/achievement";
import type { DomainEvent as DomainEventType } from "@cf-twitch/contracts/domain-event";
import { IsoTimestamp, StreamId, ViewerId } from "@cf-twitch/contracts/identity";
import { Achievements } from "./achievements-service.ts";
import { achievementMigrationLoader } from "./achievement-migrations.ts";
import {
  acceptsAchievementTransition,
  achievementTriggersForEvent,
  evaluateAchievementProgress,
  type AchievementProgressDecision,
  type AchievementTrigger,
} from "./achievement-rules.ts";

const StoredProgress = Schema.Struct({
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  achievementId: AchievementId,
  progress: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unlockedAt: Schema.OptionFromNullOr(IsoTimestamp),
  eventId: Schema.OptionFromNullOr(Schema.String),
  announcementState: Schema.Literals(["pending", "sending", "sent", "abandoned", "uncertain"]),
});

const StoredStreak = Schema.Struct({
  userId: ViewerId,
  userDisplayName: Schema.NonEmptyString,
  sessionStreak: Schema.Int,
  longestStreak: Schema.Int,
  lastRequestAt: Schema.OptionFromNullOr(IsoTimestamp),
  sessionStartedAt: Schema.OptionFromNullOr(IsoTimestamp),
});

const StoredSession = Schema.Struct({
  status: Schema.Literals(["online", "offline"]),
  streamId: Schema.OptionFromNullOr(StreamId),
  startedAt: Schema.OptionFromNullOr(IsoTimestamp),
  transitionAt: IsoTimestamp,
});

const parseProgress = Schema.decodeUnknownEffect(Schema.Array(StoredProgress));

const parseStreaks = Schema.decodeUnknownEffect(Schema.Array(StoredStreak));

const parseCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })));

const parseEvents = Schema.decodeUnknownEffect(Schema.Array(AchievementDebugEvent));

const parseRanking = Schema.decodeUnknownEffect(Schema.Array(AchievementLeaderboardEntry));

const parseUnlocks = Schema.decodeUnknownEffect(Schema.Array(UnlockedAchievement));

const parseDefinitionIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: AchievementId })),
);

const parseDeleted = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));

// Non-numeric metadata intentionally falls back to the explicit increment.
const parseStreakCount = Schema.decodeUnknownOption(Schema.Number);

const refineStreakIncrement = Schema.decodeEffect(Schema.Int.check(Schema.isGreaterThan(0)));

const parseTimestamp = Schema.decodeEffect(IsoTimestamp);

const streakIncrementFailure = Effect.mapError(
  () => new AchievementError({ operation: "recordEvent", reason: "invalid_input" }),
);

const achievementFailure = (operation: string) =>
  Effect.mapError((error: Schema.SchemaError | SqlError.SqlError | AchievementError) =>
    error._tag === "AchievementError"
      ? error
      : new AchievementError({
          operation,
          reason: error._tag === "SchemaError" ? "invalid_stored_data" : "persistence_unavailable",
        }),
  );

const normalizeAchievementUser = (value: string) => value.trim().replace(/^@+/, "").toLowerCase();

const normalizeLooseAchievementUser = (value: string) =>
  normalizeAchievementUser(value).replaceAll("_", "");

const achievementHistoryInput = (event: DomainEventType) => {
  switch (event.type) {
    case "song_request_success":
      return {
        userId: event.userId,
        userDisplayName: event.userDisplayName,
        metadata: JSON.stringify({ trackId: event.trackId, sagaId: event.sagaId }),
      };
    case "raffle_roll":
      return {
        userId: event.userId,
        userDisplayName: event.userDisplayName,
        metadata: JSON.stringify({
          roll: event.roll,
          winningNumber: event.winningNumber,
          distance: event.distance,
          isWinner: event.isWinner,
          sagaId: event.sagaId,
        }),
      };
    case "stream_online":
      return {
        userId: "system",
        userDisplayName: "System",
        metadata: JSON.stringify({ streamId: event.streamId, startedAt: event.startedAt }),
      };
    case "stream_offline":
      return {
        userId: "system",
        userDisplayName: "System",
        metadata: JSON.stringify({ streamId: event.streamId, endedAt: event.endedAt }),
      };
  }
};

/** Construct the achievement SQL authority only after complete baseline schema adoption. */
export const makeAchievements = Effect.gen(function* () {
  yield* SqliteMigrator.run({
    loader: achievementMigrationLoader,
    table: "achievement_effect_migrations",
  });
  const sql = yield* SqlClient.SqlClient;
  // Recovery is owned by the SQL authority, not the obsolete Agent JSON projection.
  const recoveredAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql`UPDATE achievement_unlock_outbox SET announcement_state='uncertain',updated_at=${recoveredAt} WHERE announcement_state='sending'`;

  const now = () =>
    Effect.flatMap(DateTime.now, (value) => parseTimestamp(DateTime.formatIso(value)));

  const progressColumns = sql.literal(
    "user_id AS userId,user_display_name AS userDisplayName,achievement_id AS achievementId,progress,unlocked_at AS unlockedAt,event_id AS eventId,announcement_state AS announcementState",
  );

  const streakColumns = sql.literal(
    "user_id AS userId,user_display_name AS userDisplayName,session_streak AS sessionStreak,longest_streak AS longestStreak,last_request_at AS lastRequestAt,session_started_at AS sessionStartedAt",
  );

  const eventColumns = sql.literal(
    "event_id AS eventId,event_type AS eventType,user_id AS userId,user_display_name AS userDisplayName,timestamp,metadata",
  );

  const readDefinitions = Effect.fn("Achievements.readDefinitions")(
    SqlSchema.findAll({
      Request: Schema.Void,
      Result: AchievementDefinition,
      execute: () =>
        sql`SELECT id,name,description,icon,category,threshold,trigger_event AS triggerEvent,scope FROM achievement_definitions`,
    }),
  );

  const readProgress = Effect.fn("Achievements.readProgress")(function* (userId: ViewerId) {
    return yield* parseProgress(
      yield* sql`SELECT ${progressColumns} FROM user_achievements WHERE user_id=${userId}`,
    );
  });

  const applyDecisions = Effect.fn("Achievements.applyDecisions")(function* (input: {
    readonly decisions: ReadonlyArray<AchievementProgressDecision>;
    readonly userId: ViewerId;
    readonly userDisplayName: string;
    readonly eventId: string;
    readonly timestamp: IsoTimestamp;
  }) {
    const unlocked: UnlockedAchievement[] = [];

    for (const decision of input.decisions) {
      const eventId = Option.getOrNull(decision.eventId);
      yield* sql`INSERT INTO user_achievements (id,user_id,user_display_name,achievement_id,progress,unlocked_at,announcement_state,event_id)
    VALUES (${`${input.userId}:${decision.achievementId}`},${input.userId},${input.userDisplayName},${decision.achievementId},${decision.progress},${Option.getOrNull(decision.unlockedAt)},'pending',${eventId})
    ON CONFLICT(user_id,achievement_id) DO UPDATE SET user_display_name=excluded.user_display_name,progress=excluded.progress,unlocked_at=excluded.unlocked_at,event_id=COALESCE(excluded.event_id,user_achievements.event_id)`;

      if (!decision.newlyUnlocked || Option.isNone(decision.unlockedAt)) continue;
      const definition = decision.definition;
      yield* sql`INSERT INTO achievement_current_unlock(user_id,achievement_id,effect_id) VALUES (${input.userId},${definition.id},${`${input.eventId}:${definition.id}`})
    ON CONFLICT(user_id,achievement_id) DO UPDATE SET effect_id=excluded.effect_id`;
      unlocked.push({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        category: definition.category,
        unlockedAt: decision.unlockedAt.value,
      });
      yield* sql`INSERT OR IGNORE INTO achievement_unlock_outbox(effect_id,event_id,user_id,user_display_name,achievement_id,achievement_name,achievement_description,category,created_at,updated_at)
    VALUES (${`${input.eventId}:${definition.id}`},${input.eventId},${input.userId},${input.userDisplayName},${definition.id},${definition.name},${definition.description},${definition.category},${input.timestamp},${input.timestamp})`;
    }

    return unlocked;
  });

  const applyTriggers = Effect.fn("Achievements.applyTriggers")(function* (input: {
    readonly triggers: ReadonlyArray<AchievementTrigger>;
    readonly userId: ViewerId;
    readonly userDisplayName: string;
    readonly eventId: string;
    readonly timestamp: IsoTimestamp;
    readonly direct: boolean;
  }) {
    yield* sql`UPDATE user_achievements SET user_display_name=${input.userDisplayName} WHERE user_id=${input.userId}`;
    const definitions = yield* readDefinitions();
    const progress = yield* readProgress(input.userId);
    const progressMap = new Map(progress.map((row) => [row.achievementId, row]));
    const unlocked: UnlockedAchievement[] = [];

    for (const trigger of input.triggers) {
      const decisions = evaluateAchievementProgress({
        definitions,
        progress: progressMap,
        trigger,
        now: input.timestamp,
        direct: input.direct,
      });

      unlocked.push(...(yield* applyDecisions({ ...input, decisions })));
    }

    return unlocked;
  });

  const insertHistory = Effect.fn("Achievements.insertHistory")(function* (input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly userId: string;
    readonly userDisplayName: string;
    readonly timestamp: IsoTimestamp;
    readonly metadata: string;
  }) {
    const rows = yield* parseDeleted(
      yield* sql`INSERT INTO event_history(id,event_type,user_id,user_display_name,event_id,timestamp,metadata)
   VALUES (${input.eventId},${input.eventType},${input.userId},${input.userDisplayName},${input.eventId},${input.timestamp},${input.metadata}) ON CONFLICT(event_id) DO NOTHING RETURNING id`,
    );

    return rows.length > 0;
  });

  const readSession = Effect.fn("Achievements.readSession")(
    SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: StoredSession,
      execute: () =>
        sql`SELECT status,stream_id AS streamId,started_at AS startedAt,transition_at AS transitionAt FROM achievement_stream_session WHERE singleton_id=1`,
    }),
  );

  const applyTransition = Effect.fn("Achievements.applyTransition")(function* (
    event: Extract<DomainEventType, { type: "stream_online" | "stream_offline" }>,
  ) {
    const session = yield* readSession();

    if (!acceptsAchievementTransition(session, event)) return;
    const online = event.type === "stream_online";
    const timestamp = online ? event.startedAt : event.endedAt;
    yield* sql`INSERT INTO achievement_stream_session(singleton_id,status,stream_id,started_at,transition_at) VALUES (1,${online ? "online" : "offline"},${event.streamId},${online ? timestamp : null},${timestamp})
   ON CONFLICT(singleton_id) DO UPDATE SET status=excluded.status,stream_id=excluded.stream_id,started_at=excluded.started_at,transition_at=excluded.transition_at`;

    if (!online) return;
    yield* sql`UPDATE user_achievements SET progress=0,unlocked_at=NULL,announcement_state='pending',event_id=NULL WHERE achievement_id IN (SELECT id FROM achievement_definitions WHERE scope='session')`;
    yield* sql`UPDATE achievement_unlock_outbox SET announcement_state='abandoned',updated_at=${timestamp} WHERE achievement_id IN (SELECT id FROM achievement_definitions WHERE scope='session') AND announcement_state<>'sent'`;
    yield* sql`DELETE FROM achievement_current_unlock WHERE achievement_id IN (SELECT id FROM achievement_definitions WHERE scope='session')`;
    yield* sql`UPDATE user_streaks SET session_streak=0,session_started_at=${timestamp}`;
  });

  const recordSongRequestStreak = Effect.fn("Achievements.recordSongRequestStreak")(function* (
    event: Extract<DomainEventType, { type: "song_request_success" }>,
    session: Option.Option<typeof StoredSession.Type>,
    timestamp: IsoTimestamp,
  ) {
    const streaks = yield* parseStreaks(
      yield* sql`SELECT ${streakColumns} FROM user_streaks WHERE user_id=${event.userId}`,
    );

    const nextStreak = (streaks[0]?.sessionStreak ?? 0) + 1;
    yield* sql`INSERT INTO user_streaks(user_id,user_display_name,session_streak,longest_streak,last_request_at,session_started_at)
     VALUES (${event.userId},${event.userDisplayName},${nextStreak},${Math.max(streaks[0]?.longestStreak ?? 0, nextStreak)},${timestamp},${Option.isSome(session) ? Option.getOrNull(session.value.startedAt) : null})
     ON CONFLICT(user_id) DO UPDATE SET user_display_name=excluded.user_display_name,session_streak=excluded.session_streak,longest_streak=excluded.longest_streak,last_request_at=excluded.last_request_at`;

    if (
      Option.isNone(session) ||
      session.value.status !== "online" ||
      Option.isNone(session.value.startedAt) ||
      Date.parse(event.timestamp) <= Date.parse(session.value.startedAt.value)
    )
      return { nextStreak, streamOpener: false };

    // Strict source-time comparison includes offset timestamps; current request is excluded from the inbox count.
    const count = yield* parseCount(
      yield* sql`SELECT COUNT(*) count FROM event_history WHERE event_type='song_request_success' AND julianday(timestamp)>julianday(${session.value.startedAt.value}) AND event_id<>${event.id}`,
    );

    return { nextStreak, streamOpener: (count[0]?.count ?? 0) === 0 };
  });

  const handleEvent = Effect.fn("Achievements.handleEvent")(function* (event: DomainEventType) {
    const timestamp = yield* now();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (
          !(yield* insertHistory({
            ...achievementHistoryInput(event),
            eventId: event.id,
            eventType: event.type,
            timestamp: event.timestamp,
          }))
        )
          return;

        if (event.type === "stream_online" || event.type === "stream_offline") {
          yield* applyTransition(event);

          return;
        }

        const session = yield* readSession();

        const streak =
          event.type === "song_request_success"
            ? yield* recordSongRequestStreak(event, session, timestamp)
            : { nextStreak: 0, streamOpener: false };

        yield* applyTriggers({
          userId: event.userId,
          userDisplayName: event.userDisplayName,
          eventId: event.id,
          timestamp,
          direct: false,
          triggers: achievementTriggersForEvent({ event, ...streak }),
        });
      }),
    );
  }, achievementFailure("handleEvent"));

  const recordEvent = Effect.fn("Achievements.recordEvent")(function* (
    input: AchievementEventInput,
  ) {
    const timestamp = yield* now();

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const metadata = Option.getOrElse(input.metadata, () => ({}));

        if (
          !(yield* insertHistory({
            eventId: input.eventId,
            eventType: `achievement:${input.event}`,
            userId: input.userId,
            userDisplayName: input.userDisplayName,
            timestamp,
            metadata: JSON.stringify(metadata),
          }))
        )
          return [];

        const streakCount = parseStreakCount(
          Option.isSome(input.metadata) ? input.metadata.value["streakCount"] : undefined,
        );

        const increment =
          input.event === "request_streak" && Option.isSome(streakCount) && streakCount.value !== 0
            ? yield* refineStreakIncrement(streakCount.value).pipe(streakIncrementFailure)
            : input.increment;

        return yield* applyTriggers({
          userId: input.userId,
          userDisplayName: input.userDisplayName,
          eventId: input.eventId,
          timestamp,
          direct: true,
          triggers: [
            {
              event: input.event,
              eventId: input.eventId,
              increment,
              mode: input.event === "request_streak" ? "set" : "increment",
            },
          ],
        });
      }),
    );
  }, achievementFailure("recordEvent"));

  const getUserAchievements = Effect.fn("Achievements.getUserAchievements")(function* (input: {
    readonly userDisplayName: string;
  }) {
    const definitions = yield* readDefinitions();

    const progress = yield* parseProgress(
      yield* sql`SELECT ${progressColumns} FROM user_achievements WHERE user_display_name=${input.userDisplayName}`,
    );

    const byId = new Map(progress.map((row) => [row.achievementId, row]));

    return definitions.map((definition): ViewerAchievementProgress => {
      const row = byId.get(definition.id);

      return {
        achievementId: definition.id,
        name: definition.name,
        description: definition.description,
        icon: definition.icon,
        category: definition.category,
        threshold: definition.threshold,
        progress: row?.progress ?? 0,
        unlocked: row !== undefined && Option.isSome(row.unlockedAt),
        unlockedAt: row?.unlockedAt ?? Option.none(),
      };
    });
  }, achievementFailure("getUserAchievements"));

  const unlockColumns = sql.literal(
    "d.id,d.name,d.description,d.icon,d.category,u.unlocked_at AS unlockedAt",
  );

  const getUnlockedAchievements = Effect.fn("Achievements.getUnlockedAchievements")(
    function* (input: { readonly userDisplayName: string }) {
      return yield* parseUnlocks(
        yield* sql`SELECT ${unlockColumns} FROM user_achievements u JOIN achievement_definitions d ON d.id=u.achievement_id WHERE u.user_display_name=${input.userDisplayName} AND u.unlocked_at IS NOT NULL ORDER BY u.unlocked_at DESC`,
      );
    },
    achievementFailure("getUnlockedAchievements"),
  );

  const getDebugTableCounts = Effect.fn("Achievements.getDebugTableCounts")(function* () {
    const count = Effect.fn("Achievements.countTable")(function* (table: string) {
      const rows = yield* parseCount(yield* sql`SELECT COUNT(*) count FROM ${sql(table)}`);

      return rows[0]?.count ?? 0;
    });

    const unlocked = yield* parseCount(
      yield* sql`SELECT COUNT(*) count FROM user_achievements WHERE unlocked_at IS NOT NULL`,
    );

    return {
      definitions: yield* count("achievement_definitions"),
      userAchievements: yield* count("user_achievements"),
      unlockedAchievements: unlocked[0]?.count ?? 0,
      userStreaks: yield* count("user_streaks"),
      eventHistory: yield* count("event_history"),
    };
  }, achievementFailure("getDebugTableCounts"));

  const getDebugUserSnapshot = Effect.fn("Achievements.getDebugUserSnapshot")(function* (input: {
    readonly userDisplayName: string;
  }) {
    const requestedUser = input.userDisplayName;
    const normalizedUser = normalizeAchievementUser(requestedUser);
    const loose = normalizeLooseAchievementUser(requestedUser);

    const progress = yield* parseProgress(
      yield* sql`SELECT ${progressColumns} FROM user_achievements`,
    );

    const streaks = yield* parseStreaks(yield* sql`SELECT ${streakColumns} FROM user_streaks`);
    const events = yield* parseEvents(yield* sql`SELECT ${eventColumns} FROM event_history`);

    const recent = yield* parseEvents(
      yield* sql`SELECT ${eventColumns} FROM event_history ORDER BY timestamp DESC LIMIT 200`,
    );

    const exact = (row: { readonly userDisplayName: string }) =>
      row.userDisplayName === requestedUser;

    const normalized = (row: { readonly userDisplayName: string }) =>
      normalizeAchievementUser(row.userDisplayName) === normalizedUser;

    const unlocked = progress.filter((row) => Option.isSome(row.unlockedAt));
    const known = new Set([...progress, ...streaks, ...events].map((row) => row.userDisplayName));

    const similarUsers = Array.from(known)
      .filter((name) => {
        const normal = normalizeAchievementUser(name);
        const candidate = normalizeLooseAchievementUser(name);

        return (
          normal === normalizedUser ||
          candidate === loose ||
          normal.includes(normalizedUser) ||
          normalizedUser.includes(normal) ||
          candidate.includes(loose) ||
          loose.includes(candidate)
        );
      })
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 20);

    return {
      requestedUser,
      normalizedUser,
      exactUserAchievementRows: progress.filter(exact).length,
      caseInsensitiveUserAchievementRows: progress.filter(normalized).length,
      exactUnlockedRows: unlocked.filter(exact).length,
      caseInsensitiveUnlockedRows: unlocked.filter(normalized).length,
      exactStreakRows: streaks.filter(exact).length,
      caseInsensitiveStreakRows: streaks.filter(normalized).length,
      exactEventHistoryRows: events.filter(exact).length,
      caseInsensitiveEventHistoryRows: events.filter(normalized).length,
      recentEvents: recent.filter(normalized),
      similarUsers,
    };
  }, achievementFailure("getDebugUserSnapshot"));

  return Achievements.of({
    handleEvent,
    recordEvent,
    getUserAchievements,
    getUnlockedAchievements,
    getDebugTableCounts,
    getDebugUserSnapshot,
    getDefinitions: Effect.fn("Achievements.getDefinitions")(
      () => readDefinitions(),
      achievementFailure("getDefinitions"),
    ),
    getLeaderboard: Effect.fn("Achievements.getLeaderboard")(function* (input) {
      return yield* parseRanking(
        yield* sql`SELECT user_display_name AS userDisplayName,COUNT(*) count FROM user_achievements WHERE unlocked_at IS NOT NULL GROUP BY user_display_name ORDER BY count DESC,user_display_name LIMIT ${Option.getOrElse(input.limit, () => 10)}`,
      );
    }, achievementFailure("getLeaderboard")),
    getUnannounced: Effect.fn("Achievements.getUnannounced")(function* () {
      const rows = yield* parseProgress(
        yield* sql`SELECT ${progressColumns} FROM user_achievements WHERE unlocked_at IS NOT NULL AND announcement_state='pending' ORDER BY unlocked_at`,
      );

      const definitions = yield* readDefinitions();

      return rows.flatMap((row) => {
        const definition = definitions.find((item) => item.id === row.achievementId);

        if (!definition || Option.isNone(row.unlockedAt)) return [];

        return [
          {
            userDisplayName: row.userDisplayName,
            achievement: {
              id: definition.id,
              name: definition.name,
              description: definition.description,
              icon: definition.icon,
              category: definition.category,
              unlockedAt: row.unlockedAt.value,
            },
          },
        ];
      });
    }, achievementFailure("getUnannounced")),
    resetOneTimeAchievements: Effect.fn("Achievements.resetOneTimeAchievements")(function* (input) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const definitions = yield* parseDefinitionIds(
            yield* sql`SELECT id FROM achievement_definitions WHERE scope='cumulative' AND threshold IS NULL`,
          );

          const achievementIds = definitions.map((row) => row.id);

          if (achievementIds.length === 0) return { deleted: 0, achievementIds };

          const userFilter = Option.isSome(input.userDisplayName)
            ? sql`user_display_name=${input.userDisplayName.value}`
            : sql.literal("1=1");

          yield* sql`DELETE FROM achievement_current_unlock WHERE ${sql.in("achievement_id", achievementIds)} AND user_id IN (SELECT user_id FROM user_achievements WHERE ${userFilter})`;

          const deleted = yield* parseDeleted(
            yield* sql`DELETE FROM user_achievements WHERE ${sql.in("achievement_id", achievementIds)} AND ${userFilter} RETURNING id`,
          );

          yield* sql`UPDATE achievement_unlock_outbox SET announcement_state='abandoned' WHERE ${sql.in("achievement_id", achievementIds)} AND ${userFilter} AND announcement_state<>'sent'`;

          return { deleted: deleted.length, achievementIds };
        }),
      );
    }, achievementFailure("resetOneTimeAchievements")),
  });
});

/** Provides the achievement authority while preserving instance-scoped SQL requirements. */
export const achievementsLayerWithoutDependencies = Layer.effect(Achievements, makeAchievements);

/** Achievement SQL has no infrastructure-backed dependencies beyond its runtime SQL client. */
export const achievementsLayer = achievementsLayerWithoutDependencies;
