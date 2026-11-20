import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import {
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import {
  SongQueueError,
  type NowPlaying,
  type PendingSongRequest,
  type RequestHistoryQuery,
  type RequestHistoryItem,
  type SongQueueLimit,
  type SongQueueOperation,
  type SongQueueResult,
  type TopRequestedTrack,
  type TopSongRequester,
} from "@cf-twitch/contracts/song-queue";
import type { ISongQueue } from "./song-queue.ts";
import {
  attributeSongQueueOccurrences,
  type SongQueueOccurrence,
} from "./song-queue-reconciliation.ts";

/** Schema for the durable song queue polling intent, which survives Durable Object eviction. */
export const SongQueueDatabaseCoordination = Schema.Struct({
  /** Epoch milliseconds of the last successful Spotify observation, absent until one succeeds. */
  lastSyncAt: Schema.OptionFromNullOr(Schema.Number),
  /** Epoch milliseconds when the next Spotify refresh is due; `0` means immediately. */
  refreshDueAt: Schema.Number,
  /** Epoch milliseconds when the next Pending Request cleanup is due; `0` means immediately. */
  cleanupDueAt: Schema.Number,
  /** Spotify refresh failures since the last success, which select the persisted backoff. */
  consecutiveSyncFailures: NonNegativeInt,
});

/** Durable song queue polling intent with absolute deadlines in epoch milliseconds. */
export interface SongQueueDatabaseCoordination extends Schema.Schema.Type<
  typeof SongQueueDatabaseCoordination
> {}

/** One parsed Spotify playback observation to reconcile with the saved Queue Occurrences. */
export interface SongQueueDatabasePlaybackObservation {
  /** Spotify Track currently playing, absent when playback is idle. */
  readonly currentlyPlaying: Option.Option<SpotifyTrack>;
  /** Upcoming Spotify Queue in provider order, excluding the current track. */
  readonly upcoming: readonly SpotifyTrack[];
  /** Instant of the observation, recorded as the playback departure time for Request History. */
  readonly syncedAt: IsoTimestamp;
}

/**
 * Song queue persistence: Pending Requests, Queue Occurrence snapshots, Request History, and
 * polling intent.
 *
 * **Details**
 *
 * Read and request operations behave as documented on `ISongQueue`, failing with
 * `SongQueueError` whose reason is `storage_unavailable` or `stored_data_invalid`.
 */
export interface ISongQueueDatabase extends Omit<ISongQueue, "refreshQueue"> {
  /**
   * Atomically attributes an observation's Queue Occurrences and records a completed request.
   *
   * **Details**
   *
   * Moves the previous attributed current occurrence to Request History when it leaves playback,
   * drops seen requests that disappeared, and expires never-seen requests older than one hour.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage fails or stored rows are invalid;
   *   a failure leaves the previous snapshot and history unchanged.
   */
  readonly reconcilePlayback: (
    input: SongQueueDatabasePlaybackObservation,
  ) => Effect.Effect<void, SongQueueError>;
  /**
   * Deletes Pending Requests requested before `before`.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage fails.
   */
  readonly cleanupPending: (before: IsoTimestamp) => Effect.Effect<void, SongQueueError>;
  /**
   * Returns the durable polling intent.
   *
   * @returns The coordination row, or fails with `SongQueueError` when storage fails or the row is
   *   missing or invalid.
   */
  readonly getCoordination: () => Effect.Effect<SongQueueDatabaseCoordination, SongQueueError>;
  /**
   * Replaces the durable polling intent.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage fails.
   */
  readonly setCoordination: (
    input: SongQueueDatabaseCoordination,
  ) => Effect.Effect<void, SongQueueError>;
}

/** Service for song queue persistence; SQL representations stay private to this module. */
export class SongQueueDatabase extends Context.Service<SongQueueDatabase, ISongQueueDatabase>()(
  "@cf-twitch/SongQueueDatabase",
) {}

const storedTrackFields = {
  track_id: SpotifyTrackId,
  track_name: Schema.NonEmptyString,
  artists: Schema.fromJsonString(SpotifyTrack.fields.artists),
  album: SpotifyTrack.fields.album,
  album_cover_url: SpotifyTrack.fields.albumCoverUrl,
};

const storedRequestFields = {
  ...storedTrackFields,
  event_id: RedemptionId,
  requester_user_id: ViewerId,
  requester_display_name: Schema.NonEmptyString,
  requested_at: IsoTimestamp,
};

const StoredPendingRequest = Schema.Struct({
  ...storedRequestFields,
  first_seen_in_spotify_at: Schema.OptionFromNullOr(IsoTimestamp),
  last_seen_in_spotify_at: Schema.OptionFromNullOr(IsoTimestamp),
});

const StoredHistoryRequest = Schema.Struct({ ...storedRequestFields, fulfilled_at: IsoTimestamp });

const snapshotFields = { ...storedTrackFields, position: NonNegativeInt, synced_at: IsoTimestamp };

const StoredQueueOccurrence = Schema.Union([
  Schema.Struct({
    ...snapshotFields,
    source: Schema.Literal("autoplay"),
    event_id: Schema.Null,
    requester_user_id: Schema.Null,
    requester_display_name: Schema.Null,
    requested_at: Schema.Null,
  }),
  Schema.Struct({
    ...snapshotFields,
    source: Schema.Literal("user"),
    event_id: RedemptionId,
    requester_user_id: ViewerId,
    requester_display_name: Schema.NonEmptyString,
    requested_at: IsoTimestamp,
  }),
]);

const parseStoredPending = Schema.decodeUnknownEffect(Schema.Array(StoredPendingRequest));

const parseStoredHistory = Schema.decodeUnknownEffect(Schema.Array(StoredHistoryRequest));

const parseStoredOccurrences = Schema.decodeUnknownEffect(Schema.Array(StoredQueueOccurrence));

const StoredCountRows = Schema.Array(Schema.Struct({ count: NonNegativeInt }));

const parseStoredCount = Schema.decodeUnknownEffect(StoredCountRows);

const storedCount = (rows: typeof StoredCountRows.Type): NonNegativeInt =>
  rows[0]?.count ?? NonNegativeInt.make(0);

const parseStoredCoordination = Schema.decodeUnknownEffect(
  Schema.Array(SongQueueDatabaseCoordination),
);

const parseTrackStats = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      track_id: SpotifyTrackId,
      track_name: Schema.NonEmptyString,
      artists: Schema.fromJsonString(SpotifyTrack.fields.artists),
      request_count: NonNegativeInt,
    }),
  ),
);

const parseViewerStats = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      user_id: ViewerId,
      display_name: Schema.NonEmptyString,
      request_count: NonNegativeInt,
    }),
  ),
);

const parseTableColumns = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
);

const parseLegacyState = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      state: Schema.fromJsonString(
        Schema.Struct({
          lastSyncAt: Schema.NullOr(IsoTimestamp),
          refreshDueAt: Schema.NullOr(IsoTimestamp),
          cleanupDueAt: Schema.NullOr(IsoTimestamp),
          consecutiveSyncFailures: NonNegativeInt,
        }),
      ),
    }),
  ),
);

const songQueueMigrations = SqliteMigrator.fromRecord({
  "1_adopt_song_queue_tables": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const importLegacySongQueueCoordination = Effect.fn(
      "SongQueueMigration.importLegacyCoordination",
    )(function* () {
      const legacyTables = yield* parseStoredCount(
        yield* sql`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'`,
      );

      if ((legacyTables[0]?.count ?? 0) === 0) return;

      const legacy = (yield* parseLegacyState(
        yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`,
      ))[0]?.state;

      if (legacy === undefined) return;
      yield* sql`UPDATE song_queue_coordination SET last_sync_at = ${legacy.lastSyncAt === null ? null : Date.parse(legacy.lastSyncAt)}, refresh_due_at = ${legacy.refreshDueAt === null ? 0 : Date.parse(legacy.refreshDueAt)}, cleanup_due_at = ${legacy.cleanupDueAt === null ? 0 : Date.parse(legacy.cleanupDueAt)}, consecutive_sync_failures = ${legacy.consecutiveSyncFailures} WHERE singleton = 1`;
    });

    yield* sql`CREATE TABLE IF NOT EXISTS pending_requests (event_id TEXT PRIMARY KEY NOT NULL, track_id TEXT NOT NULL, track_name TEXT NOT NULL, artists TEXT NOT NULL, album TEXT NOT NULL, album_cover_url TEXT, requester_user_id TEXT NOT NULL, requester_display_name TEXT NOT NULL, requested_at TEXT NOT NULL, first_seen_in_spotify_at TEXT, last_seen_in_spotify_at TEXT)`;
    yield* sql`CREATE TABLE IF NOT EXISTS request_history (event_id TEXT PRIMARY KEY NOT NULL, track_id TEXT NOT NULL, track_name TEXT NOT NULL, artists TEXT NOT NULL, album TEXT NOT NULL, album_cover_url TEXT, requester_user_id TEXT NOT NULL, requester_display_name TEXT NOT NULL, requested_at TEXT NOT NULL, fulfilled_at TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS spotify_queue_snapshot (position INTEGER PRIMARY KEY NOT NULL, track_id TEXT NOT NULL, track_name TEXT NOT NULL, artists TEXT NOT NULL, album TEXT NOT NULL, album_cover_url TEXT, synced_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'autoplay', event_id TEXT, requester_user_id TEXT, requester_display_name TEXT, requested_at TEXT)`;

    // Adopt both baseline Drizzle revisions without replacing any historical row.
    const pendingColumns = yield* parseTableColumns(
      yield* sql`PRAGMA table_info(pending_requests)`,
    );

    for (const [name, addColumn] of [
      [
        "first_seen_in_spotify_at",
        sql`ALTER TABLE pending_requests ADD COLUMN first_seen_in_spotify_at TEXT`,
      ],
      [
        "last_seen_in_spotify_at",
        sql`ALTER TABLE pending_requests ADD COLUMN last_seen_in_spotify_at TEXT`,
      ],
    ] as const) {
      if (!pendingColumns.some((column) => column.name === name)) yield* addColumn;
    }

    const snapshotColumns = yield* parseTableColumns(
      yield* sql`PRAGMA table_info(spotify_queue_snapshot)`,
    );

    for (const [name, addColumn] of [
      [
        "source",
        sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN source TEXT NOT NULL DEFAULT 'autoplay'`,
      ],
      ["event_id", sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN event_id TEXT`],
      [
        "requester_user_id",
        sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN requester_user_id TEXT`,
      ],
      [
        "requester_display_name",
        sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN requester_display_name TEXT`,
      ],
      ["requested_at", sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN requested_at TEXT`],
    ] as const) {
      if (!snapshotColumns.some((column) => column.name === name)) yield* addColumn;
    }

    yield* sql`CREATE INDEX IF NOT EXISTS idx_request_history_fulfilled_at ON request_history(fulfilled_at)`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_request_history_requester ON request_history(requester_user_id)`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_request_history_track ON request_history(track_id)`;
    yield* sql`CREATE TABLE song_queue_receipts (event_id TEXT PRIMARY KEY NOT NULL)`;
    yield* sql`INSERT OR IGNORE INTO song_queue_receipts SELECT event_id FROM pending_requests UNION SELECT event_id FROM request_history`;
    yield* sql`CREATE TABLE song_queue_coordination (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_sync_at REAL, refresh_due_at REAL NOT NULL, cleanup_due_at REAL NOT NULL, consecutive_sync_failures INTEGER NOT NULL)`;
    yield* sql`INSERT INTO song_queue_coordination VALUES (1, (SELECT (julianday(MAX(synced_at))-2440587.5)*86400000 FROM spotify_queue_snapshot), 0, 0, 0)`;

    yield* importLegacySongQueueCoordination();
  }),
});

const storedTrack = (
  row:
    | Schema.Schema.Type<typeof StoredPendingRequest>
    | Schema.Schema.Type<typeof StoredQueueOccurrence>,
): SpotifyTrack => ({
  id: row.track_id,
  name: row.track_name,
  artists: row.artists,
  album: row.album,
  albumCoverUrl: row.album_cover_url,
});

const storedRequest = (
  row: Schema.Schema.Type<typeof StoredPendingRequest>,
): PendingSongRequest => ({
  eventId: row.event_id,
  track: storedTrack(row),
  requesterUserId: row.requester_user_id,
  requesterDisplayName: row.requester_display_name,
  requestedAt: row.requested_at,
});

const storedOccurrence = (
  row: Schema.Schema.Type<typeof StoredQueueOccurrence>,
): SongQueueOccurrence => ({
  position: row.position,
  track:
    row.source === "autoplay"
      ? { ...storedTrack(row), source: "autoplay" }
      : {
          ...storedTrack(row),
          source: "user",
          eventId: row.event_id,
          requesterUserId: row.requester_user_id,
          requesterDisplayName: row.requester_display_name,
          requestedAt: row.requested_at,
        },
});

/** Returns the request whose attributed current occurrence left playback in this observation. */
const completedRequestEventId = (
  previous: readonly SongQueueOccurrence[],
  attributed: readonly SongQueueOccurrence[],
): Option.Option<RedemptionId> => {
  const previousCurrent = previous.find((item) => item.position === 0)?.track;
  const nextCurrent = attributed.find((item) => item.position === 0)?.track;

  return previousCurrent?.source === "user" &&
    (nextCurrent?.source !== "user" || previousCurrent.eventId !== nextCurrent.eventId)
    ? Option.some(previousCurrent.eventId)
    : Option.none();
};

/** Returns the presented queue page: requested occurrences FIFO by request time, then autoplay. */
const songQueuePage = (
  occurrences: readonly SongQueueOccurrence[],
  limit: SongQueueLimit,
): SongQueueResult => {
  const upcoming = occurrences.flatMap((item) => (item.position > 0 ? [item.track] : []));

  const users = upcoming
    .filter((track) => track.source === "user")
    .toSorted((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));

  return {
    tracks: [...users, ...upcoming.filter((track) => track.source === "autoplay")].slice(0, limit),
    totalCount: NonNegativeInt.make(upcoming.length),
  };
};

/** Returns the Now Playing projection of a Queue Occurrence snapshot. */
const nowPlaying = (occurrences: readonly SongQueueOccurrence[]): NowPlaying => ({
  track: Option.fromUndefinedOr(occurrences.find((item) => item.position === 0)?.track),
  position: 0,
});

const storedHistory = (
  row: Schema.Schema.Type<typeof StoredHistoryRequest>,
): RequestHistoryItem => ({
  eventId: row.event_id,
  trackId: row.track_id,
  trackName: row.track_name,
  artists: row.artists,
  album: row.album,
  albumCoverUrl: row.album_cover_url,
  requesterUserId: row.requester_user_id,
  requesterDisplayName: row.requester_display_name,
  requestedAt: row.requested_at,
  fulfilledAt: row.fulfilled_at,
});

/** Returns a transform that classifies SQL and stored-row failures for one song queue operation. */
const songQueueDatabaseFailure =
  (operation: SongQueueOperation, eventId: Option.Option<RedemptionId> = Option.none()) =>
  <A, R>(
    effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | SongQueueError, R>,
  ): Effect.Effect<A, SongQueueError, R> =>
    effect.pipe(
      Effect.catchTags({
        SongQueueError: (error) => Effect.fail(error),
        SqlError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "storage_unavailable", eventId })),
        SchemaError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "stored_data_invalid", eventId })),
      }),
    );

/**
 * Creates song queue persistence over SQLite after additive, transactional baseline adoption.
 *
 * **Details**
 *
 * Runs the `song_queue_schema_migrations` migration, which preserves historical Drizzle tables and
 * imports legacy Agent polling state without copying opaque schedule IDs.
 *
 * @returns The database service, or fails with `MigrationError` or `SqlError` when adoption fails;
 *   malformed legacy Agent state rolls the migration back.
 */
export const makeSongQueueDatabase = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: songQueueMigrations, table: "song_queue_schema_migrations" });
  const sql = yield* SqlClient.SqlClient;

  const readOccurrences = Effect.fn("SongQueueDatabase.readOccurrences")(function* () {
    return (yield* parseStoredOccurrences(
      yield* sql`SELECT * FROM spotify_queue_snapshot ORDER BY position`,
    )).map(storedOccurrence);
  });

  const completePlayedRequest = Effect.fn("SongQueueDatabase.completePlayedRequest")(function* (
    completed: Option.Option<RedemptionId>,
    syncedAt: IsoTimestamp,
  ) {
    if (Option.isNone(completed)) return;
    const eventId = completed.value;
    yield* sql`INSERT OR IGNORE INTO request_history (event_id, track_id, track_name, artists, album, album_cover_url, requester_user_id, requester_display_name, requested_at, fulfilled_at) SELECT event_id, track_id, track_name, artists, album, album_cover_url, requester_user_id, requester_display_name, requested_at, ${syncedAt} FROM pending_requests WHERE event_id = ${eventId}`;
    yield* sql`DELETE FROM pending_requests WHERE event_id = ${eventId}`;
  });

  const replaceOccurrenceSnapshot = Effect.fn("SongQueueDatabase.replaceOccurrenceSnapshot")(
    function* (attributed: readonly SongQueueOccurrence[], syncedAt: IsoTimestamp) {
      yield* sql`DELETE FROM spotify_queue_snapshot`;

      for (const { position, track } of attributed) {
        // Autoplay occurrences store SQL NULL in every attribution column.
        const attribution =
          track.source === "user"
            ? {
                eventId: track.eventId,
                requesterUserId: track.requesterUserId,
                requesterDisplayName: track.requesterDisplayName,
                requestedAt: track.requestedAt,
              }
            : {
                eventId: null,
                requesterUserId: null,
                requesterDisplayName: null,
                requestedAt: null,
              };

        yield* sql`INSERT INTO spotify_queue_snapshot (position, track_id, track_name, artists, album, album_cover_url, synced_at, source, event_id, requester_user_id, requester_display_name, requested_at) VALUES (${position}, ${track.id}, ${track.name}, ${JSON.stringify(track.artists)}, ${track.album}, ${Option.getOrNull(track.albumCoverUrl)}, ${syncedAt}, ${track.source}, ${attribution.eventId}, ${attribution.requesterUserId}, ${attribution.requesterDisplayName}, ${attribution.requestedAt})`;

        if (track.source === "user")
          yield* sql`UPDATE pending_requests SET first_seen_in_spotify_at = COALESCE(first_seen_in_spotify_at, ${syncedAt}), last_seen_in_spotify_at = ${syncedAt} WHERE event_id = ${track.eventId}`;
      }
    },
  );

  const getTrackStatistics = Effect.fn("SongQueueDatabase.getTrackStatistics")(function* (
    userId: Option.Option<ViewerId>,
    limit: SongQueueLimit,
  ): Effect.fn.Return<readonly TopRequestedTrack[], SqlError.SqlError | Schema.SchemaError> {
    const viewer = Option.getOrNull(userId);

    const rows = yield* parseTrackStats(
      yield* sql`
      WITH ranked AS (SELECT *, COUNT(*) OVER (PARTITION BY track_id) AS request_count,
        ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY julianday(fulfilled_at) DESC, event_id DESC) AS rank
        FROM request_history WHERE (${viewer} IS NULL OR requester_user_id = ${viewer}))
      SELECT track_id, track_name, artists, request_count FROM ranked WHERE rank = 1 ORDER BY request_count DESC, track_id ASC LIMIT ${limit}`,
    );

    return rows.map((row) => ({
      trackId: row.track_id,
      trackName: row.track_name,
      artists: row.artists,
      requestCount: row.request_count,
    }));
  });

  return SongQueueDatabase.of({
    persistRequest: Effect.fn("SongQueueDatabase.persistRequest")(
      function* (input) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const inserted =
              yield* sql`INSERT OR IGNORE INTO song_queue_receipts (event_id) VALUES (${input.eventId}) RETURNING event_id`;

            if (inserted.length === 0) return;
            yield* sql`INSERT INTO pending_requests (event_id, track_id, track_name, artists, album, album_cover_url, requester_user_id, requester_display_name, requested_at) VALUES (${input.eventId}, ${input.track.id}, ${input.track.name}, ${JSON.stringify(input.track.artists)}, ${input.track.album}, ${Option.getOrNull(input.track.albumCoverUrl)}, ${input.requesterUserId}, ${input.requesterDisplayName}, ${input.requestedAt})`;
            yield* sql`UPDATE song_queue_coordination SET last_sync_at = NULL, refresh_due_at = 0 WHERE singleton = 1`;
          }),
        );
      },
      (effect, input) =>
        effect.pipe(songQueueDatabaseFailure("persistRequest", Option.some(input.eventId))),
    ),
    deleteRequest: Effect.fn("SongQueueDatabase.deleteRequest")(
      function* ({ eventId }) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Keep a compensation tombstone so late workflow replay cannot resurrect the request.
            yield* sql`INSERT OR IGNORE INTO song_queue_receipts (event_id) VALUES (${eventId})`;
            yield* sql`DELETE FROM pending_requests WHERE event_id = ${eventId}`;
            yield* sql`UPDATE spotify_queue_snapshot SET source = 'autoplay', event_id = NULL, requester_user_id = NULL, requester_display_name = NULL, requested_at = NULL WHERE event_id = ${eventId}`;
          }),
        );
      },
      (effect, input) =>
        effect.pipe(songQueueDatabaseFailure("deleteRequest", Option.some(input.eventId))),
    ),
    getCurrentlyPlaying: Effect.fn("SongQueueDatabase.getCurrentlyPlaying")(function* () {
      return nowPlaying(yield* readOccurrences());
    }, songQueueDatabaseFailure("getCurrentlyPlaying")),
    getSongQueue: Effect.fn("SongQueueDatabase.getSongQueue")(function* ({ limit }) {
      return songQueuePage(yield* readOccurrences(), limit);
    }, songQueueDatabaseFailure("getSongQueue")),
    getRequestHistory: Effect.fn("SongQueueDatabase.getRequestHistory")(function* (
      input: RequestHistoryQuery,
    ) {
      const since = Option.getOrNull(input.since);
      const until = Option.getOrNull(input.until);

      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* parseStoredHistory(
            yield* sql`SELECT * FROM request_history WHERE (${since} IS NULL OR julianday(fulfilled_at) >= julianday(${since})) AND (${until} IS NULL OR julianday(fulfilled_at) <= julianday(${until})) ORDER BY julianday(fulfilled_at) DESC, event_id DESC LIMIT ${input.limit} OFFSET ${input.offset}`,
          );

          const totalCount = storedCount(
            yield* parseStoredCount(
              yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE (${since} IS NULL OR julianday(fulfilled_at) >= julianday(${since})) AND (${until} IS NULL OR julianday(fulfilled_at) <= julianday(${until}))`,
            ),
          );

          return { requests: rows.map(storedHistory), totalCount };
        }),
      );
    }, songQueueDatabaseFailure("getRequestHistory")),
    getUserRequestCount: Effect.fn("SongQueueDatabase.getUserRequestCount")(function* ({ userId }) {
      return storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE requester_user_id = ${userId}`,
        ),
      );
    }, songQueueDatabaseFailure("getUserRequestCount")),
    getUserRequestCountByDisplayName: Effect.fn(
      "SongQueueDatabase.getUserRequestCountByDisplayName",
    )(function* ({ displayName }) {
      return storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE requester_display_name = ${displayName}`,
        ),
      );
    }, songQueueDatabaseFailure("getUserRequestCountByDisplayName")),
    getSessionRequestCount: Effect.fn("SongQueueDatabase.getSessionRequestCount")(function* ({
      since,
    }) {
      return storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE julianday(fulfilled_at) >= julianday(${since})`,
        ),
      );
    }, songQueueDatabaseFailure("getSessionRequestCount")),
    getTopTracks: Effect.fn("SongQueueDatabase.getTopTracks")(
      ({ limit }) => getTrackStatistics(Option.none(), limit),
      songQueueDatabaseFailure("getTopTracks"),
    ),
    getTopTracksByUser: Effect.fn("SongQueueDatabase.getTopTracksByUser")(
      ({ userId, limit }) => getTrackStatistics(Option.some(userId), limit),
      songQueueDatabaseFailure("getTopTracksByUser"),
    ),
    getTopRequesters: Effect.fn("SongQueueDatabase.getTopRequesters")(function* ({
      limit,
    }): Effect.fn.Return<readonly TopSongRequester[], SqlError.SqlError | Schema.SchemaError> {
      const rows = yield* parseViewerStats(
        yield* sql`WITH ranked AS (SELECT *, COUNT(*) OVER (PARTITION BY requester_user_id) AS request_count, ROW_NUMBER() OVER (PARTITION BY requester_user_id ORDER BY julianday(fulfilled_at) DESC, event_id DESC) AS rank FROM request_history) SELECT requester_user_id AS user_id, requester_display_name AS display_name, request_count FROM ranked WHERE rank = 1 ORDER BY request_count DESC, user_id ASC LIMIT ${limit}`,
      );

      return rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        requestCount: row.request_count,
      }));
    }, songQueueDatabaseFailure("getTopRequesters")),
    checkDuplicateRequest: Effect.fn("SongQueueDatabase.checkDuplicateRequest")(function* ({
      userId,
      trackId,
      windowMinutes,
    }) {
      const now = yield* Clock.currentTimeMillis;
      const since = new Date(now - windowMinutes * 60_000).toISOString();

      const count = storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM (SELECT event_id FROM pending_requests WHERE requester_user_id = ${userId} AND track_id = ${trackId} AND julianday(requested_at) >= julianday(${since}) UNION ALL SELECT event_id FROM request_history WHERE requester_user_id = ${userId} AND track_id = ${trackId} AND julianday(fulfilled_at) >= julianday(${since}))`,
        ),
      );

      return count > 0;
    }, songQueueDatabaseFailure("checkDuplicateRequest")),
    reconcilePlayback: Effect.fn("SongQueueDatabase.reconcilePlayback")(function* ({
      currentlyPlaying,
      upcoming,
      syncedAt,
    }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* readOccurrences();

          const pendingRows = yield* parseStoredPending(
            yield* sql`SELECT * FROM pending_requests ORDER BY julianday(requested_at), event_id`,
          );

          const pending = pendingRows.map(storedRequest);

          const attributed = attributeSongQueueOccurrences({
            previous,
            pending,
            currentlyPlaying,
            upcoming,
          });

          yield* completePlayedRequest(completedRequestEventId(previous, attributed), syncedAt);
          yield* replaceOccurrenceSnapshot(attributed, syncedAt);

          yield* sql`DELETE FROM pending_requests WHERE first_seen_in_spotify_at IS NOT NULL AND event_id NOT IN (SELECT event_id FROM spotify_queue_snapshot WHERE event_id IS NOT NULL)`;
          yield* sql`DELETE FROM pending_requests WHERE julianday(requested_at) < julianday(${syncedAt}) - (1.0 / 24)`;
          yield* sql`UPDATE song_queue_coordination SET last_sync_at = ${Date.parse(syncedAt)}, consecutive_sync_failures = 0 WHERE singleton = 1`;
        }),
      );
    }, songQueueDatabaseFailure("reconcilePlayback")),
    cleanupPending: Effect.fn("SongQueueDatabase.cleanupPending")(function* (before) {
      yield* sql`DELETE FROM pending_requests WHERE julianday(requested_at) < julianday(${before})`;
    }, songQueueDatabaseFailure("cleanupPending")),
    getCoordination: Effect.fn("SongQueueDatabase.getCoordination")(function* () {
      const row = (yield* parseStoredCoordination(
        yield* sql`SELECT last_sync_at AS lastSyncAt, refresh_due_at AS refreshDueAt, cleanup_due_at AS cleanupDueAt, consecutive_sync_failures AS consecutiveSyncFailures FROM song_queue_coordination WHERE singleton = 1`,
      ))[0];

      if (row === undefined)
        return yield* new SongQueueError({
          operation: "getCoordination",
          reason: "stored_data_invalid",
        });

      return row;
    }, songQueueDatabaseFailure("getCoordination")),
    setCoordination: Effect.fn("SongQueueDatabase.setCoordination")(function* (input) {
      yield* sql`UPDATE song_queue_coordination SET last_sync_at = ${Option.getOrNull(input.lastSyncAt)}, refresh_due_at = ${input.refreshDueAt}, cleanup_due_at = ${input.cleanupDueAt}, consecutive_sync_failures = ${input.consecutiveSyncFailures} WHERE singleton = 1`;
    }, songQueueDatabaseFailure("setCoordination")),
  });
});

/** Layer that provides song queue persistence, leaving the SQL client visible. */
export const songQueueDatabaseLayerWithoutDependencies = Layer.effect(
  SongQueueDatabase,
  makeSongQueueDatabase,
);

/** Layer that provides song queue persistence; the SQL client is the Durable Object's runtime binding. */
export const songQueueDatabaseLayer = songQueueDatabaseLayerWithoutDependencies;

/** In-memory Pending Request with the first time Spotify was observed playing or queueing it. */
interface InMemorySongQueuePendingRequest {
  readonly request: PendingSongRequest;
  readonly firstSeenInSpotifyAt: Option.Option<IsoTimestamp>;
}

/** Complete in-memory song queue state, replaced atomically by each mutation. */
interface InMemorySongQueueState {
  readonly receipts: ReadonlySet<RedemptionId>;
  readonly pending: ReadonlyMap<RedemptionId, InMemorySongQueuePendingRequest>;
  readonly occurrences: readonly SongQueueOccurrence[];
  readonly history: readonly RequestHistoryItem[];
  readonly coordination: SongQueueDatabaseCoordination;
}

/** Orders Request History rows the way SQL does: newest departure first, then event ID descending. */
const newestHistoryFirst = (a: RequestHistoryItem, b: RequestHistoryItem): number =>
  Date.parse(b.fulfilledAt) - Date.parse(a.fulfilledAt) ||
  (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0);

/** Returns played history ranked per group, keeping each group's count and newest row. */
const rankHistory = <K extends string>(
  history: readonly RequestHistoryItem[],
  key: (item: RequestHistoryItem) => K,
): ReadonlyArray<{
  readonly key: K;
  readonly latest: RequestHistoryItem;
  readonly count: number;
}> => {
  const groups = new Map<K, { latest: RequestHistoryItem; count: number }>();

  for (const item of history.toSorted(newestHistoryFirst)) {
    const group = groups.get(key(item));

    if (group === undefined) groups.set(key(item), { latest: item, count: 1 });
    else group.count += 1;
  }

  return [...groups].map(([groupKey, group]) => ({ key: groupKey, ...group }));
};

/** Orders ranked groups by count descending, then key ascending. */
const mostPlayedFirst = (
  a: { readonly key: string; readonly count: number },
  b: { readonly key: string; readonly count: number },
): number => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Returns the in-memory state after reconciling one playback observation, mirroring the SQL transaction. */
const reconcileInMemoryPlayback = (
  state: InMemorySongQueueState,
  { currentlyPlaying, upcoming, syncedAt }: SongQueueDatabasePlaybackObservation,
): InMemorySongQueueState => {
  const pendingRequests = [...state.pending.values()]
    .map((entry) => entry.request)
    .toSorted(
      (a, b) =>
        Date.parse(a.requestedAt) - Date.parse(b.requestedAt) ||
        (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    );

  const attributed = attributeSongQueueOccurrences({
    previous: state.occurrences,
    pending: pendingRequests,
    currentlyPlaying,
    upcoming,
  });

  const pending = new Map(state.pending);
  let history = state.history;
  const completed = completedRequestEventId(state.occurrences, attributed);

  if (Option.isSome(completed)) {
    const played = pending.get(completed.value);

    if (played !== undefined && !history.some((item) => item.eventId === completed.value)) {
      const { request } = played;
      history = [
        ...history,
        {
          eventId: request.eventId,
          trackId: request.track.id,
          trackName: request.track.name,
          artists: request.track.artists,
          album: request.track.album,
          albumCoverUrl: request.track.albumCoverUrl,
          requesterUserId: request.requesterUserId,
          requesterDisplayName: request.requesterDisplayName,
          requestedAt: request.requestedAt,
          fulfilledAt: syncedAt,
        },
      ];
    }

    pending.delete(completed.value);
  }

  const attributedIds = new Set(
    attributed.flatMap(({ track }) => (track.source === "user" ? [track.eventId] : [])),
  );

  for (const eventId of attributedIds) {
    const entry = pending.get(eventId);

    if (entry !== undefined)
      pending.set(eventId, {
        request: entry.request,
        firstSeenInSpotifyAt: Option.orElse(entry.firstSeenInSpotifyAt, () =>
          Option.some(syncedAt),
        ),
      });
  }

  const expiredBefore = Date.parse(syncedAt) - 3_600_000;

  for (const [eventId, entry] of pending) {
    const disappeared = Option.isSome(entry.firstSeenInSpotifyAt) && !attributedIds.has(eventId);

    if (disappeared || Date.parse(entry.request.requestedAt) < expiredBefore)
      pending.delete(eventId);
  }

  return {
    receipts: state.receipts,
    pending,
    occurrences: attributed,
    history,
    coordination: {
      lastSyncAt: Option.some(Date.parse(syncedAt)),
      refreshDueAt: state.coordination.refreshDueAt,
      cleanupDueAt: state.coordination.cleanupDueAt,
      consecutiveSyncFailures: NonNegativeInt.make(0),
    },
  };
};

/** Creates an in-memory song queue database that follows the SQL implementation's semantics. */
const makeSongQueueDatabaseTest = Effect.gen(function* () {
  const state = yield* Ref.make<InMemorySongQueueState>({
    receipts: new Set(),
    pending: new Map(),
    occurrences: [],
    history: [],
    coordination: {
      lastSyncAt: Option.none(),
      refreshDueAt: 0,
      cleanupDueAt: 0,
      consecutiveSyncFailures: NonNegativeInt.make(0),
    },
  });

  const readHistory = Ref.get(state).pipe(Effect.map((current) => current.history));

  const topTracks = (viewer: Option.Option<ViewerId>, limit: SongQueueLimit) =>
    readHistory.pipe(
      Effect.map((history): readonly TopRequestedTrack[] =>
        rankHistory(
          history.filter((item) =>
            Option.match(viewer, {
              onNone: () => true,
              onSome: (userId) => item.requesterUserId === userId,
            }),
          ),
          (item) => item.trackId,
        )
          .toSorted(mostPlayedFirst)
          .slice(0, limit)
          .map((group) => ({
            trackId: group.latest.trackId,
            trackName: group.latest.trackName,
            artists: group.latest.artists,
            requestCount: NonNegativeInt.make(group.count),
          })),
      ),
    );

  const countHistory = (matches: (item: RequestHistoryItem) => boolean) =>
    readHistory.pipe(Effect.map((history) => NonNegativeInt.make(history.filter(matches).length)));

  return SongQueueDatabase.of({
    persistRequest: (input) =>
      Ref.update(state, (current) => {
        if (current.receipts.has(input.eventId)) return current;

        return {
          ...current,
          receipts: new Set([...current.receipts, input.eventId]),
          pending: new Map([
            ...current.pending,
            [input.eventId, { request: input, firstSeenInSpotifyAt: Option.none() }],
          ]),
          coordination: {
            lastSyncAt: Option.none(),
            refreshDueAt: 0,
            cleanupDueAt: current.coordination.cleanupDueAt,
            consecutiveSyncFailures: current.coordination.consecutiveSyncFailures,
          },
        };
      }),
    deleteRequest: ({ eventId }) =>
      Ref.update(state, (current) => {
        const pending = new Map(current.pending);
        pending.delete(eventId);

        return {
          ...current,
          receipts: new Set([...current.receipts, eventId]),
          pending,
          occurrences: current.occurrences.map((occurrence): SongQueueOccurrence =>
            occurrence.track.source === "user" && occurrence.track.eventId === eventId
              ? {
                  position: occurrence.position,
                  track: {
                    id: occurrence.track.id,
                    name: occurrence.track.name,
                    artists: occurrence.track.artists,
                    album: occurrence.track.album,
                    albumCoverUrl: occurrence.track.albumCoverUrl,
                    source: "autoplay",
                  },
                }
              : occurrence,
          ),
        };
      }),
    getCurrentlyPlaying: () =>
      Ref.get(state).pipe(Effect.map((current) => nowPlaying(current.occurrences))),
    getSongQueue: ({ limit }) =>
      Ref.get(state).pipe(Effect.map((current) => songQueuePage(current.occurrences, limit))),
    getRequestHistory: (input) =>
      readHistory.pipe(
        Effect.map((history) => {
          const matching = history
            .filter(
              (item) =>
                Option.match(input.since, {
                  onNone: () => true,
                  onSome: (since) => Date.parse(item.fulfilledAt) >= Date.parse(since),
                }) &&
                Option.match(input.until, {
                  onNone: () => true,
                  onSome: (until) => Date.parse(item.fulfilledAt) <= Date.parse(until),
                }),
            )
            .toSorted(newestHistoryFirst);

          return {
            requests: matching.slice(input.offset, input.offset + input.limit),
            totalCount: NonNegativeInt.make(matching.length),
          };
        }),
      ),
    getUserRequestCount: ({ userId }) => countHistory((item) => item.requesterUserId === userId),
    getUserRequestCountByDisplayName: ({ displayName }) =>
      countHistory((item) => item.requesterDisplayName === displayName),
    getSessionRequestCount: ({ since }) =>
      countHistory((item) => Date.parse(item.fulfilledAt) >= Date.parse(since)),
    getTopTracks: ({ limit }) => topTracks(Option.none(), limit),
    getTopTracksByUser: ({ userId, limit }) => topTracks(Option.some(userId), limit),
    getTopRequesters: ({ limit }) =>
      readHistory.pipe(
        Effect.map((history): readonly TopSongRequester[] =>
          rankHistory(history, (item) => item.requesterUserId)
            .toSorted(mostPlayedFirst)
            .slice(0, limit)
            .map((group) => ({
              userId: group.latest.requesterUserId,
              displayName: group.latest.requesterDisplayName,
              requestCount: NonNegativeInt.make(group.count),
            })),
        ),
      ),
    checkDuplicateRequest: ({ userId, trackId, windowMinutes }) =>
      Effect.gen(function* () {
        const since = (yield* Clock.currentTimeMillis) - windowMinutes * 60_000;
        const current = yield* Ref.get(state);

        return (
          [...current.pending.values()].some(
            ({ request }) =>
              request.requesterUserId === userId &&
              request.track.id === trackId &&
              Date.parse(request.requestedAt) >= since,
          ) ||
          current.history.some(
            (item) =>
              item.requesterUserId === userId &&
              item.trackId === trackId &&
              Date.parse(item.fulfilledAt) >= since,
          )
        );
      }),
    reconcilePlayback: (input) =>
      Ref.update(state, (current) => reconcileInMemoryPlayback(current, input)),
    cleanupPending: (before) =>
      Ref.update(state, (current) => ({
        ...current,
        pending: new Map(
          [...current.pending].filter(
            ([, entry]) => Date.parse(entry.request.requestedAt) >= Date.parse(before),
          ),
        ),
      })),
    getCoordination: () => Ref.get(state).pipe(Effect.map((current) => current.coordination)),
    setCoordination: (coordination) =>
      Ref.update(state, (current) => ({ ...current, coordination })),
  });
});

/**
 * Layer that provides in-memory song queue persistence with the same observable behavior as SQL.
 *
 * **Details**
 *
 * Shares Queue Occurrence attribution and queue presentation with the SQL implementation; the
 * database contract tests run against both. Historical adoption and storage failures are SQL-only.
 */
export const songQueueDatabaseTestLayer = Layer.effect(
  SongQueueDatabase,
  makeSongQueueDatabaseTest,
);
