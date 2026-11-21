import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Context, DateTime, Effect, Layer, Option, Schema, SynchronizedRef } from "effect";
import { SqlClient, SqlSchema, type SqlError } from "effect/sql";
import {
  AchievementDebugEvent,
  type AchievementDebugTableCounts,
  type AchievementDebugUserSnapshot,
  AchievementDefinition,
  AchievementError,
  type AchievementErrorIdentifiers,
  type AchievementEventInput,
  AchievementId,
  AchievementLeaderboardEntry,
  type AchievementLeaderboardQuery,
  type AchievementOperation,
  type AchievementTriggerEvent,
  type AchievementResetResult,
  type UnannouncedAchievement,
  UnlockedAchievement,
  type ViewerAchievementProgress,
  achievementErrorIdentifiersForDisplayName,
  achievementErrorIdentifiersForDomainEvent,
  achievementErrorIdentifiersForEventInput,
  achievementErrorIdentifiersForReset,
  achievementErrorWithoutIdentifiers,
} from "@cf-twitch/contracts/achievement";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import {
  type EventId,
  IsoTimestamp,
  PositiveInt,
  StreamId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { achievementMigrationLoader } from "./achievement-migrations.ts";
import {
  type AchievementProgressRecord,
  achievementHistoryRecordForEvent,
  projectUnannouncedAchievements,
  projectViewerAchievementProgress,
  summarizeAchievementDebugUser,
} from "./achievement-projections.ts";
import {
  acceptsAchievementTransition,
  achievementStreamOpenerStart,
  achievementTriggersForEvent,
  evaluateAchievementProgress,
  type AchievementProgressDecision,
  type AchievementSession,
  type AchievementTrigger,
} from "./achievement-rules.ts";

/** Achievement authority that owns Achievement Progress, the event inbox, Stream Session resets, and unlock announcement intents. */
export interface IAchievements {
  /**
   * Applies one domain event to Achievement Progress, at most once per event ID.
   *
   * **Details**
   *
   * The inbox record, progress, Request Streak, Stream Session decision, and unlock announcement
   * intents commit atomically. A redelivered event ID has no further effect.
   *
   * @returns Nothing. Fails with `AchievementError` `invalid_stored_data` when stored records fail
   *   validation, `persistence_unavailable` when storage fails, or `invalid_response` or
   *   `transport_unavailable` when the achievements server cannot be reached or understood.
   */
  readonly handleEvent: (event: DomainEvent) => Effect.Effect<void, AchievementError>;
  /**
   * Applies one direct achievement trigger, sharing event ID deduplication with domain events.
   *
   * @returns The achievements this trigger unlocked; empty for a redelivered event ID. Fails with
   *   `AchievementError` `invalid_input` when `streakCount` metadata is not a positive whole number,
   *   or with the storage and transport reasons listed on `handleEvent`.
   */
  readonly recordEvent: (
    input: AchievementEventInput,
  ) => Effect.Effect<ReadonlyArray<UnlockedAchievement>, AchievementError>;
  /**
   * Returns all thirteen historical Achievement Definitions, including their scope.
   *
   * @returns The definitions. Fails with `AchievementError` `invalid_stored_data`,
   *   `persistence_unavailable`, `invalid_response`, or `transport_unavailable`.
   */
  readonly getDefinitions: () => Effect.Effect<
    ReadonlyArray<AchievementDefinition>,
    AchievementError
  >;
  /**
   * Returns progress toward every definition for the Viewer whose current display name matches exactly.
   *
   * @returns One row per definition, with zero progress for definitions the Viewer has not started.
   *   Fails with the same `AchievementError` reasons as `getDefinitions`.
   */
  readonly getUserAchievements: (input: {
    readonly userDisplayName: string;
  }) => Effect.Effect<ReadonlyArray<ViewerAchievementProgress>, AchievementError>;
  /**
   * Returns unlocked achievements, newest first, for the Viewer whose current display name matches exactly.
   *
   * @returns The unlocked achievements. Fails with the same `AchievementError` reasons as `getDefinitions`.
   */
  readonly getUnlockedAchievements: (input: {
    readonly userDisplayName: string;
  }) => Effect.Effect<ReadonlyArray<UnlockedAchievement>, AchievementError>;
  /**
   * Ranks display names by unlocked achievement count, at most one hundred rows.
   *
   * @returns The ranking. Fails with the same `AchievementError` reasons as `getDefinitions`.
   */
  readonly getLeaderboard: (
    input: AchievementLeaderboardQuery,
  ) => Effect.Effect<ReadonlyArray<AchievementLeaderboardEntry>, AchievementError>;
  /**
   * Returns unlocks whose chat announcement is still pending, including unlocks from before the outbox.
   *
   * @returns The pending unlocks, oldest first. Fails with the same `AchievementError` reasons as
   *   `getDefinitions`.
   */
  readonly getUnannounced: () => Effect.Effect<
    ReadonlyArray<UnannouncedAchievement>,
    AchievementError
  >;
  /**
   * Returns authoritative achievement table row counts for administrative diagnosis.
   *
   * @returns The counts. Fails with the same `AchievementError` reasons as `getDefinitions`.
   */
  readonly getDebugTableCounts: () => Effect.Effect<AchievementDebugTableCounts, AchievementError>;
  /**
   * Diagnoses exact, case-insensitive, and loose display-name matches without merging Viewer IDs.
   *
   * @returns The diagnostic snapshot. Fails with the same `AchievementError` reasons as `getDefinitions`.
   */
  readonly getDebugUserSnapshot: (input: {
    readonly userDisplayName: string;
  }) => Effect.Effect<AchievementDebugUserSnapshot, AchievementError>;
  /**
   * Resets one-time event achievements, which are cumulative definitions without a threshold.
   *
   * **Details**
   *
   * `None` resets every Viewer; otherwise only rows with the exact display name. Pending announcements
   * of the removed unlocks are abandoned.
   *
   * @returns The removed row count and targeted definitions. Fails with the same `AchievementError`
   *   reasons as `getDefinitions`.
   */
  readonly resetOneTimeAchievements: (input: {
    readonly userDisplayName: Option.Option<string>;
  }) => Effect.Effect<AchievementResetResult, AchievementError>;
}

/** Service tag shared by the SQL achievement authority and its Durable Object HTTP client. */
export class Achievements extends Context.Service<Achievements, IAchievements>()(
  "@cf-twitch/Achievements",
) {}

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

/** `COUNT(*)` always returns exactly one row. */
const parseCount = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ count: Schema.Int })]));

const parseEvents = Schema.decodeUnknownEffect(Schema.Array(AchievementDebugEvent));

const parseRanking = Schema.decodeUnknownEffect(Schema.Array(AchievementLeaderboardEntry));

const parseUnlocks = Schema.decodeUnknownEffect(Schema.Array(UnlockedAchievement));

const parseDefinitionIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: AchievementId })),
);

const parseDeleted = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));

// Non-numeric streak metadata intentionally falls back to the explicit increment.
const parseStreakCount = Schema.decodeUnknownOption(Schema.Number);

const refineStreakIncrement = Schema.decodeEffect(PositiveInt);

const parseTimestamp = Schema.decodeEffect(IsoTimestamp);

/** Event type recorded in achievement history: a domain event type, or `achievement:` plus a direct trigger. */
type AchievementHistoryEventType = DomainEvent["type"] | `achievement:${AchievementTriggerEvent}`;

/**
 * Returns an `Effect.fn` transform that translates achievement storage failures into `AchievementError`.
 *
 * `identify` derives the error's safe identifiers from the operation's own arguments. An existing
 * `AchievementError` passes through unchanged; any other failure type is a compile error until classified.
 *
 * @returns A transform whose effect fails only with `AchievementError`: `invalid_stored_data` for
 *   `SchemaError` and `persistence_unavailable` for `SqlError`.
 */
const translateAchievementStorageErrors =
  <Args extends ReadonlyArray<unknown>>(
    operation: AchievementOperation,
    identify: (...args: Args) => AchievementErrorIdentifiers,
  ) =>
  <A>(
    effect: Effect.Effect<A, AchievementError | Schema.SchemaError | SqlError.SqlError>,
    ...args: Args
  ): Effect.Effect<A, AchievementError> => {
    const identifiers = identify(...args);

    return effect.pipe(
      Effect.catchTags({
        AchievementError: (error) => Effect.fail(error),
        SchemaError: () =>
          Effect.fail(
            new AchievementError({ operation, reason: "invalid_stored_data", ...identifiers }),
          ),
        SqlError: () =>
          Effect.fail(
            new AchievementError({ operation, reason: "persistence_unavailable", ...identifiers }),
          ),
      }),
    );
  };

/**
 * Returns the trigger a direct achievement event applies.
 *
 * A non-zero numeric `streakCount` replaces the increment of a `request_streak` trigger; it must be a
 * positive whole number. Non-numeric metadata falls back to the explicit increment.
 *
 * @returns The trigger, or fails with `AchievementError` `invalid_input` when `streakCount` is a
 *   non-zero number that is not a positive whole number.
 */
const directAchievementTrigger = Effect.fn("Achievements.directAchievementTrigger")(function* (
  input: AchievementEventInput,
) {
  const streakCount = parseStreakCount(
    Option.isSome(input.metadata) ? input.metadata.value["streakCount"] : undefined,
  );

  const increment =
    input.event === "request_streak" && Option.isSome(streakCount) && streakCount.value !== 0
      ? yield* refineStreakIncrement(streakCount.value).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new AchievementError({
                operation: "recordEvent",
                reason: "invalid_input",
                ...achievementErrorIdentifiersForEventInput(input),
              }),
            ),
          ),
        )
      : input.increment;

  return {
    event: input.event,
    eventId: input.eventId,
    increment,
    mode: input.event === "request_streak" ? "set" : "increment",
  } satisfies AchievementTrigger;
});

/**
 * Effect that builds the SQL achievement authority over the Durable Object's SQLite storage.
 *
 * **Details**
 *
 * Runs the achievement migrations, then marks announcements interrupted mid-send as `uncertain`
 * before serving any request. Agent JSON projections are never imported.
 *
 * @returns The authority. Fails with `MigrationError` or `SqlError` when the migrations or the
 *   recovery update cannot run, including when a pre-viewer-ID database is rejected.
 */
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
    readonly eventId: EventId;
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
    readonly eventId: EventId;
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
    readonly eventId: EventId;
    readonly eventType: AchievementHistoryEventType;
    readonly userId: ViewerId | "system";
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
    event: Extract<DomainEvent, { type: "stream_online" | "stream_offline" }>,
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
    event: Extract<DomainEvent, { type: "song_request_success" }>,
    session: Option.Option<AchievementSession>,
    timestamp: IsoTimestamp,
  ) {
    const [current] = yield* parseStreaks(
      yield* sql`SELECT ${streakColumns} FROM user_streaks WHERE user_id=${event.userId}`,
    );

    const streak = Option.fromUndefinedOr(current);

    const nextStreak =
      Option.match(streak, { onNone: () => 0, onSome: (row) => row.sessionStreak }) + 1;

    const longestStreak = Math.max(
      Option.match(streak, { onNone: () => 0, onSome: (row) => row.longestStreak }),
      nextStreak,
    );

    yield* sql`INSERT INTO user_streaks(user_id,user_display_name,session_streak,longest_streak,last_request_at,session_started_at)
     VALUES (${event.userId},${event.userDisplayName},${nextStreak},${longestStreak},${timestamp},${Option.getOrNull(Option.flatMap(session, (value) => value.startedAt))})
     ON CONFLICT(user_id) DO UPDATE SET user_display_name=excluded.user_display_name,session_streak=excluded.session_streak,longest_streak=excluded.longest_streak,last_request_at=excluded.last_request_at`;

    const sessionStartedAt = achievementStreamOpenerStart(session, event);

    if (Option.isNone(sessionStartedAt)) return { nextStreak, streamOpener: false };

    // Strict source-time comparison includes offset timestamps; current request is excluded from the inbox count.
    const [earlier] = yield* parseCount(
      yield* sql`SELECT COUNT(*) count FROM event_history WHERE event_type='song_request_success' AND julianday(timestamp)>julianday(${sessionStartedAt.value}) AND event_id<>${event.id}`,
    );

    return { nextStreak, streamOpener: earlier.count === 0 };
  });

  const handleEvent = Effect.fn("Achievements.handleEvent")(
    function* (event: DomainEvent) {
      const timestamp = yield* now();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* insertHistory({
              ...achievementHistoryRecordForEvent(event),
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
    },
    translateAchievementStorageErrors("handleEvent", achievementErrorIdentifiersForDomainEvent),
  );

  const recordEvent = Effect.fn("Achievements.recordEvent")(
    function* (input: AchievementEventInput) {
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

          return yield* applyTriggers({
            userId: input.userId,
            userDisplayName: input.userDisplayName,
            eventId: input.eventId,
            timestamp,
            direct: true,
            triggers: [yield* directAchievementTrigger(input)],
          });
        }),
      );
    },
    translateAchievementStorageErrors("recordEvent", achievementErrorIdentifiersForEventInput),
  );

  const getUserAchievements = Effect.fn("Achievements.getUserAchievements")(
    function* (input: { readonly userDisplayName: string }) {
      const definitions = yield* readDefinitions();

      const progress = yield* parseProgress(
        yield* sql`SELECT ${progressColumns} FROM user_achievements WHERE user_display_name=${input.userDisplayName}`,
      );

      return projectViewerAchievementProgress(definitions, progress);
    },
    translateAchievementStorageErrors(
      "getUserAchievements",
      achievementErrorIdentifiersForDisplayName,
    ),
  );

  const unlockColumns = sql.literal(
    "d.id,d.name,d.description,d.icon,d.category,u.unlocked_at AS unlockedAt",
  );

  const getUnlockedAchievements = Effect.fn("Achievements.getUnlockedAchievements")(
    function* (input: { readonly userDisplayName: string }) {
      return yield* parseUnlocks(
        yield* sql`SELECT ${unlockColumns} FROM user_achievements u JOIN achievement_definitions d ON d.id=u.achievement_id WHERE u.user_display_name=${input.userDisplayName} AND u.unlocked_at IS NOT NULL ORDER BY u.unlocked_at DESC`,
      );
    },
    translateAchievementStorageErrors(
      "getUnlockedAchievements",
      achievementErrorIdentifiersForDisplayName,
    ),
  );

  const getDebugTableCounts = Effect.fn("Achievements.getDebugTableCounts")(
    function* () {
      const count = Effect.fn("Achievements.countTable")(function* (table: string) {
        const [rows] = yield* parseCount(yield* sql`SELECT COUNT(*) count FROM ${sql(table)}`);

        return rows.count;
      });

      const [unlocked] = yield* parseCount(
        yield* sql`SELECT COUNT(*) count FROM user_achievements WHERE unlocked_at IS NOT NULL`,
      );

      return {
        definitions: yield* count("achievement_definitions"),
        userAchievements: yield* count("user_achievements"),
        unlockedAchievements: unlocked.count,
        userStreaks: yield* count("user_streaks"),
        eventHistory: yield* count("event_history"),
      };
    },
    translateAchievementStorageErrors(
      "getDebugTableCounts",
      () => achievementErrorWithoutIdentifiers,
    ),
  );

  const getDebugUserSnapshot = Effect.fn("Achievements.getDebugUserSnapshot")(
    function* (input: { readonly userDisplayName: string }) {
      const progress = yield* parseProgress(
        yield* sql`SELECT ${progressColumns} FROM user_achievements`,
      );

      const streaks = yield* parseStreaks(yield* sql`SELECT ${streakColumns} FROM user_streaks`);
      const events = yield* parseEvents(yield* sql`SELECT ${eventColumns} FROM event_history`);

      const recentEvents = yield* parseEvents(
        yield* sql`SELECT ${eventColumns} FROM event_history ORDER BY timestamp DESC LIMIT 200`,
      );

      return summarizeAchievementDebugUser({
        requestedUser: input.userDisplayName,
        progress,
        streakDisplayNames: streaks.map((row) => row.userDisplayName),
        events,
        recentEvents,
      });
    },
    translateAchievementStorageErrors(
      "getDebugUserSnapshot",
      achievementErrorIdentifiersForDisplayName,
    ),
  );

  return Achievements.of({
    handleEvent,
    recordEvent,
    getUserAchievements,
    getUnlockedAchievements,
    getDebugTableCounts,
    getDebugUserSnapshot,
    getDefinitions: Effect.fn("Achievements.getDefinitions")(
      () => readDefinitions(),
      translateAchievementStorageErrors("getDefinitions", () => achievementErrorWithoutIdentifiers),
    ),
    getLeaderboard: Effect.fn("Achievements.getLeaderboard")(
      function* (input) {
        return yield* parseRanking(
          yield* sql`SELECT user_display_name AS userDisplayName,COUNT(*) count FROM user_achievements WHERE unlocked_at IS NOT NULL GROUP BY user_display_name ORDER BY count DESC,user_display_name LIMIT ${Option.getOrElse(input.limit, () => 10)}`,
        );
      },
      translateAchievementStorageErrors("getLeaderboard", () => achievementErrorWithoutIdentifiers),
    ),
    getUnannounced: Effect.fn("Achievements.getUnannounced")(
      function* () {
        const rows = yield* parseProgress(
          yield* sql`SELECT ${progressColumns} FROM user_achievements WHERE unlocked_at IS NOT NULL AND announcement_state='pending' ORDER BY unlocked_at`,
        );

        return projectUnannouncedAchievements(yield* readDefinitions(), rows);
      },
      translateAchievementStorageErrors("getUnannounced", () => achievementErrorWithoutIdentifiers),
    ),
    resetOneTimeAchievements: Effect.fn("Achievements.resetOneTimeAchievements")(
      function* (input) {
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
      },
      translateAchievementStorageErrors(
        "resetOneTimeAchievements",
        achievementErrorIdentifiersForReset,
      ),
    ),
  });
});

/** Layer that provides the SQL achievement authority while leaving the Durable Object `SqlClient` required. */
export const achievementsLayerWithoutDependencies = Layer.effect(Achievements, makeAchievements);

/**
 * Production Layer for the SQL achievement authority.
 *
 * **Details**
 *
 * Its only dependency is the Durable Object's `SqlClient`, which the achievements server supplies in
 * its runtime phase, so this Layer selects nothing further.
 */
export const achievementsLayer = achievementsLayerWithoutDependencies;

/** The thirteen historical definitions seeded by the baseline achievement migration, in seed order. */
const achievementTestDefinitions: ReadonlyArray<AchievementDefinition> = [
  AchievementDefinition.make({
    id: AchievementId.make("first_request"),
    name: "First Timer",
    description: "Request your first song",
    icon: "1f3b5",
    category: "song_request",
    threshold: Option.some(1),
    triggerEvent: "song_request",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("request_10"),
    name: "Regular",
    description: "Request 10 songs",
    icon: "1f3b6",
    category: "song_request",
    threshold: Option.some(10),
    triggerEvent: "song_request",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("request_50"),
    name: "DJ in Training",
    description: "Request 50 songs",
    icon: "1f3a7",
    category: "song_request",
    threshold: Option.some(50),
    triggerEvent: "song_request",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("request_100"),
    name: "Certified DJ",
    description: "Request 100 songs",
    icon: "1f4bf",
    category: "song_request",
    threshold: Option.some(100),
    triggerEvent: "song_request",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("stream_opener"),
    name: "Stream Opener",
    description: "First song request of the stream",
    icon: "1f305",
    category: "special",
    threshold: Option.none(),
    triggerEvent: "stream_first_request",
    scope: "session",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("first_roll"),
    name: "Feeling Lucky",
    description: "Enter your first raffle",
    icon: "1f3b2",
    category: "raffle",
    threshold: Option.some(1),
    triggerEvent: "raffle_roll",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("roll_25"),
    name: "Persistent",
    description: "Enter 25 raffles",
    icon: "1f3b0",
    category: "raffle",
    threshold: Option.some(25),
    triggerEvent: "raffle_roll",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("roll_100"),
    name: "Never Give Up",
    description: "Enter 100 raffles",
    icon: "1f4aa",
    category: "raffle",
    threshold: Option.some(100),
    triggerEvent: "raffle_roll",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("first_win"),
    name: "Winner Winner",
    description: "Win your first raffle",
    icon: "1f3c6",
    category: "raffle",
    threshold: Option.some(1),
    triggerEvent: "raffle_win",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("close_call"),
    name: "So Close",
    description: "Roll within 100 of winning number",
    icon: "1f62c",
    category: "raffle",
    threshold: Option.none(),
    triggerEvent: "raffle_close",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("closest_ever"),
    name: "Heartbreaker",
    description: "Hold the closest non-winning roll record",
    icon: "1f494",
    category: "special",
    threshold: Option.none(),
    triggerEvent: "raffle_closest_record",
    scope: "cumulative",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("streak_3"),
    name: "On a Roll",
    description: "3 successful requests in a row",
    icon: "1f525",
    category: "engagement",
    threshold: Option.some(3),
    triggerEvent: "request_streak",
    scope: "session",
  }),
  AchievementDefinition.make({
    id: AchievementId.make("streak_5"),
    name: "Hot Streak",
    description: "5 successful requests in a row",
    icon: "26a1",
    category: "engagement",
    threshold: Option.some(5),
    triggerEvent: "request_streak",
    scope: "session",
  }),
];

/** In-memory Request Streak state for one Viewer. */
interface InMemoryAchievementStreak {
  readonly userDisplayName: string;
  readonly sessionStreak: number;
  readonly longestStreak: number;
}

/** In-memory achievement state mirroring the SQL progress, streak, Stream Session, and history tables. */
interface InMemoryAchievementsState {
  /** Progress keyed by `<viewer ID>:<achievement ID>`, in first-write order. */
  readonly progress: ReadonlyMap<string, AchievementProgressRecord>;
  readonly streaks: ReadonlyMap<ViewerId, InMemoryAchievementStreak>;
  readonly session: Option.Option<AchievementSession>;
  /** Inbox history in arrival order; its event IDs deduplicate delivery. */
  readonly history: ReadonlyArray<AchievementDebugEvent>;
}

/** Mutable copy of the in-memory state, changed by one operation and committed only when it succeeds. */
interface InMemoryAchievementsDraft {
  readonly progress: Map<string, AchievementProgressRecord>;
  readonly streaks: Map<ViewerId, InMemoryAchievementStreak>;
  session: Option.Option<AchievementSession>;
  readonly history: Array<AchievementDebugEvent>;
}

const draftInMemoryAchievements = (
  state: InMemoryAchievementsState,
): InMemoryAchievementsDraft => ({
  progress: new Map(state.progress),
  streaks: new Map(state.streaks),
  session: state.session,
  history: [...state.history],
});

/** Records an inbox event in the draft, returning `false` when its event ID was already recorded. */
const recordInMemoryAchievementHistory = (
  draft: InMemoryAchievementsDraft,
  event: AchievementDebugEvent,
): boolean => {
  if (draft.history.some((row) => row.eventId === event.eventId)) return false;
  draft.history.push(event);

  return true;
};

/** Applies triggers to the draft with the SQL authority's upsert rules, returning newly unlocked achievements. */
const applyInMemoryAchievementTriggers = (
  draft: InMemoryAchievementsDraft,
  input: {
    readonly triggers: ReadonlyArray<AchievementTrigger>;
    readonly userId: ViewerId;
    readonly userDisplayName: string;
    readonly timestamp: IsoTimestamp;
    readonly direct: boolean;
  },
): ReadonlyArray<UnlockedAchievement> => {
  for (const [key, row] of draft.progress)
    if (row.userId === input.userId)
      draft.progress.set(key, { ...row, userDisplayName: input.userDisplayName });

  const progressMap = new Map(
    Array.from(draft.progress.values())
      .filter((row) => row.userId === input.userId)
      .map((row) => [row.achievementId, row]),
  );

  const unlocked: UnlockedAchievement[] = [];

  for (const trigger of input.triggers)
    for (const decision of evaluateAchievementProgress({
      definitions: achievementTestDefinitions,
      progress: progressMap,
      trigger,
      now: input.timestamp,
      direct: input.direct,
    })) {
      const key = `${input.userId}:${decision.achievementId}`;
      const previous = Option.fromUndefinedOr(draft.progress.get(key));

      draft.progress.set(key, {
        userId: input.userId,
        userDisplayName: input.userDisplayName,
        achievementId: decision.achievementId,
        progress: decision.progress,
        unlockedAt: decision.unlockedAt,
        eventId: Option.orElse(decision.eventId, () =>
          Option.flatMap(previous, (row) => row.eventId),
        ),
        announcementState: Option.match(previous, {
          onNone: () => "pending",
          onSome: (row) => row.announcementState,
        }),
      });

      if (decision.newlyUnlocked && Option.isSome(decision.unlockedAt))
        unlocked.push({
          id: decision.definition.id,
          name: decision.definition.name,
          description: decision.definition.description,
          icon: decision.definition.icon,
          category: decision.definition.category,
          unlockedAt: decision.unlockedAt.value,
        });
    }

  return unlocked;
};

/** Applies an accepted Stream Session transition to the draft, resetting session progress when a session starts. */
const applyInMemoryAchievementTransition = (
  draft: InMemoryAchievementsDraft,
  event: Extract<DomainEvent, { type: "stream_online" | "stream_offline" }>,
): void => {
  if (!acceptsAchievementTransition(draft.session, event)) return;
  const online = event.type === "stream_online";
  const timestamp = online ? event.startedAt : event.endedAt;

  draft.session = Option.some({
    status: online ? "online" : "offline",
    streamId: Option.some(event.streamId),
    startedAt: online ? Option.some(timestamp) : Option.none(),
    transitionAt: timestamp,
  });

  if (!online) return;

  const sessionAchievementIds = new Set(
    achievementTestDefinitions.flatMap((definition) =>
      definition.scope === "session" ? [definition.id] : [],
    ),
  );

  for (const [key, row] of draft.progress)
    if (sessionAchievementIds.has(row.achievementId))
      draft.progress.set(key, {
        ...row,
        progress: 0,
        unlockedAt: Option.none(),
        announcementState: "pending",
        eventId: Option.none(),
      });

  for (const [viewerId, streak] of draft.streaks)
    draft.streaks.set(viewerId, { ...streak, sessionStreak: 0 });
};

/** Advances the Viewer's Request Streak in the draft and decides whether the request is the Stream Opener. */
const recordInMemorySongRequestStreak = (
  draft: InMemoryAchievementsDraft,
  event: Extract<DomainEvent, { type: "song_request_success" }>,
) => {
  const streak = Option.fromUndefinedOr(draft.streaks.get(event.userId));

  const nextStreak =
    Option.match(streak, { onNone: () => 0, onSome: (row) => row.sessionStreak }) + 1;

  draft.streaks.set(event.userId, {
    userDisplayName: event.userDisplayName,
    sessionStreak: nextStreak,
    longestStreak: Math.max(
      Option.match(streak, { onNone: () => 0, onSome: (row) => row.longestStreak }),
      nextStreak,
    ),
  });

  const sessionStartedAt = achievementStreamOpenerStart(draft.session, event);

  if (Option.isNone(sessionStartedAt)) return { nextStreak, streamOpener: false };
  const startedAtMs = Date.parse(sessionStartedAt.value);

  return {
    nextStreak,
    streamOpener: !draft.history.some(
      (row) =>
        row.eventType === "song_request_success" &&
        row.eventId !== event.id &&
        Date.parse(row.timestamp) > startedAtMs,
    ),
  };
};

/** Compares text by UTF-16 code units, matching the default ordering the SQL authority sorts with. */
const compareAchievementText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Effect that builds an in-memory achievement authority with the same Achievement Rules as SQL.
 *
 * **Details**
 *
 * Each write applies to a copy of the state that is committed only when the whole operation succeeds,
 * standing in for SQL transactions. It keeps no unlock announcement outbox, so every unlock stays
 * pending announcement.
 *
 * @returns The authority; building it cannot fail. Its methods fail only with `AchievementError`
 *   `invalid_input` for rejected `streakCount` metadata.
 */
const makeInMemoryAchievements = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<InMemoryAchievementsState>({
    progress: new Map(),
    streaks: new Map(),
    session: Option.none(),
    history: [],
  });

  const now = () =>
    Effect.flatMap(DateTime.now, (value) => parseTimestamp(DateTime.formatIso(value)));

  const readProgress = Effect.map(SynchronizedRef.get(state), (current) =>
    Array.from(current.progress.values()),
  );

  const toUnlockedAchievement = (row: AchievementProgressRecord) =>
    Option.flatMap(
      Option.fromUndefinedOr(
        achievementTestDefinitions.find((definition) => definition.id === row.achievementId),
      ),
      (definition) =>
        Option.map(row.unlockedAt, (unlockedAt): UnlockedAchievement => ({
          id: definition.id,
          name: definition.name,
          description: definition.description,
          icon: definition.icon,
          category: definition.category,
          unlockedAt,
        })),
    );

  return Achievements.of({
    handleEvent: Effect.fn("InMemoryAchievements.handleEvent")(
      function* (event) {
        const timestamp = yield* now();

        yield* SynchronizedRef.update(state, (current) => {
          const draft = draftInMemoryAchievements(current);
          const history = achievementHistoryRecordForEvent(event);

          if (
            !recordInMemoryAchievementHistory(draft, {
              eventId: event.id,
              eventType: event.type,
              userId: history.userId,
              userDisplayName: history.userDisplayName,
              timestamp: event.timestamp,
              metadata: Option.some(history.metadata),
            })
          )
            return current;

          if (event.type === "stream_online" || event.type === "stream_offline")
            applyInMemoryAchievementTransition(draft, event);
          else
            applyInMemoryAchievementTriggers(draft, {
              userId: event.userId,
              userDisplayName: event.userDisplayName,
              timestamp,
              direct: false,
              triggers: achievementTriggersForEvent({
                event,
                ...(event.type === "song_request_success"
                  ? recordInMemorySongRequestStreak(draft, event)
                  : { nextStreak: 0, streamOpener: false }),
              }),
            });

          return draft;
        });
      },
      translateAchievementStorageErrors("handleEvent", achievementErrorIdentifiersForDomainEvent),
    ),
    recordEvent: Effect.fn("InMemoryAchievements.recordEvent")(
      function* (input) {
        const timestamp = yield* now();

        return yield* SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            const draft = draftInMemoryAchievements(current);

            if (
              !recordInMemoryAchievementHistory(draft, {
                eventId: input.eventId,
                eventType: `achievement:${input.event}`,
                userId: input.userId,
                userDisplayName: input.userDisplayName,
                timestamp,
                metadata: Option.some(JSON.stringify(Option.getOrElse(input.metadata, () => ({})))),
              })
            )
              return [[], current] as const;

            const unlocked = applyInMemoryAchievementTriggers(draft, {
              userId: input.userId,
              userDisplayName: input.userDisplayName,
              timestamp,
              direct: true,
              triggers: [yield* directAchievementTrigger(input)],
            });

            return [unlocked, draft] as const;
          }),
        );
      },
      translateAchievementStorageErrors("recordEvent", achievementErrorIdentifiersForEventInput),
    ),
    getDefinitions: () => Effect.succeed(achievementTestDefinitions),
    getUserAchievements: Effect.fn("InMemoryAchievements.getUserAchievements")(function* (input) {
      return projectViewerAchievementProgress(
        achievementTestDefinitions,
        (yield* readProgress).filter((row) => row.userDisplayName === input.userDisplayName),
      );
    }),
    getUnlockedAchievements: Effect.fn("InMemoryAchievements.getUnlockedAchievements")(
      function* (input) {
        return (yield* readProgress)
          .filter((row) => row.userDisplayName === input.userDisplayName)
          .flatMap((row) => Option.toArray(toUnlockedAchievement(row)))
          .sort((left, right) => compareAchievementText(right.unlockedAt, left.unlockedAt));
      },
    ),
    getLeaderboard: Effect.fn("InMemoryAchievements.getLeaderboard")(function* (input) {
      const counts = new Map<string, number>();

      for (const row of yield* readProgress)
        if (Option.isSome(row.unlockedAt))
          counts.set(row.userDisplayName, (counts.get(row.userDisplayName) ?? 0) + 1);

      return Array.from(counts, ([userDisplayName, count]) =>
        AchievementLeaderboardEntry.make({ userDisplayName, count }),
      )
        .sort(
          (left, right) =>
            right.count - left.count ||
            compareAchievementText(left.userDisplayName, right.userDisplayName),
        )
        .slice(
          0,
          Option.getOrElse(input.limit, () => 10),
        );
    }),
    getUnannounced: Effect.fn("InMemoryAchievements.getUnannounced")(function* () {
      return projectUnannouncedAchievements(
        achievementTestDefinitions,
        (yield* readProgress)
          .filter((row) => row.announcementState === "pending")
          .flatMap((row) =>
            Option.match(row.unlockedAt, {
              onNone: () => [],
              onSome: (unlockedAt) => [{ row, unlockedAt }],
            }),
          )
          .sort((left, right) => compareAchievementText(left.unlockedAt, right.unlockedAt))
          .map(({ row }) => row),
      );
    }),
    getDebugTableCounts: Effect.fn("InMemoryAchievements.getDebugTableCounts")(function* () {
      const current = yield* SynchronizedRef.get(state);
      const progress = Array.from(current.progress.values());

      return {
        definitions: achievementTestDefinitions.length,
        userAchievements: progress.length,
        unlockedAchievements: progress.filter((row) => Option.isSome(row.unlockedAt)).length,
        userStreaks: current.streaks.size,
        eventHistory: current.history.length,
      };
    }),
    getDebugUserSnapshot: Effect.fn("InMemoryAchievements.getDebugUserSnapshot")(function* (input) {
      const current = yield* SynchronizedRef.get(state);

      return summarizeAchievementDebugUser({
        requestedUser: input.userDisplayName,
        progress: Array.from(current.progress.values()),
        streakDisplayNames: Array.from(current.streaks.values(), (row) => row.userDisplayName),
        events: current.history,
        recentEvents: [...current.history]
          .sort((left, right) => compareAchievementText(right.timestamp, left.timestamp))
          .slice(0, 200),
      });
    }),
    resetOneTimeAchievements: Effect.fn("InMemoryAchievements.resetOneTimeAchievements")(
      function* (input) {
        const achievementIds = achievementTestDefinitions.flatMap((definition) =>
          definition.scope === "cumulative" && Option.isNone(definition.threshold)
            ? [definition.id]
            : [],
        );

        return yield* SynchronizedRef.modify(state, (current) => {
          const draft = draftInMemoryAchievements(current);
          let deleted = 0;

          for (const [key, row] of draft.progress)
            if (
              achievementIds.includes(row.achievementId) &&
              Option.match(input.userDisplayName, {
                onNone: () => true,
                onSome: (name) => row.userDisplayName === name,
              })
            ) {
              draft.progress.delete(key);
              deleted++;
            }

          return [{ deleted, achievementIds }, draft] as const;
        });
      },
    ),
  });
});

/**
 * Test Layer that provides a complete in-memory achievement authority.
 *
 * **Details**
 *
 * It applies the same Achievement Rules, deduplication, Stream Session resets, Request Streaks, and
 * projections as the SQL authority; the achievement parity tests run the same journeys against both.
 * Storage failures cannot occur, and with no announcement outbox every unlock stays pending.
 */
export const achievementsTestLayer = Layer.effect(Achievements, makeInMemoryAchievements);
