import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
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
  type PendingSongRequest,
  type RequestHistoryQuery,
  type RequestHistoryItem,
  type SongQueueLimit,
  type TopRequestedTrack,
  type TopSongRequester,
} from "@cf-twitch/contracts/song-queue";
import type { ISongQueue } from "./song-queue.ts";
import {
  attributeSongQueueOccurrences,
  type SongQueueOccurrence,
} from "./song-queue-reconciliation.ts";

/** Durable polling intent survives eviction, including empty/offline Spotify responses. */
export const SongQueueCoordination = Schema.Struct({
  lastSyncAt: Schema.OptionFromNullOr(Schema.Number),
  refreshDueAt: Schema.Number,
  cleanupDueAt: Schema.Number,
  consecutiveSyncFailures: NonNegativeInt,
});
/** Absolute polling deadlines are milliseconds since the Unix epoch. */
export interface SongQueueCoordination extends Schema.Schema.Type<typeof SongQueueCoordination> {}

/** SQLite song queue capability owns atomic occurrence transitions and historical queries. */
export interface ISongQueueDatabase extends Omit<ISongQueue, "refreshQueue"> {
  readonly reconcilePlayback: (input: {
    readonly currentlyPlaying: Option.Option<SpotifyTrack>;
    readonly upcoming: readonly SpotifyTrack[];
    readonly syncedAt: IsoTimestamp;
  }) => Effect.Effect<void, SongQueueError>;
  readonly cleanupPending: (before: IsoTimestamp) => Effect.Effect<void, SongQueueError>;
  readonly getCoordination: () => Effect.Effect<SongQueueCoordination, SongQueueError>;
  readonly setCoordination: (input: SongQueueCoordination) => Effect.Effect<void, SongQueueError>;
}
/** Parsed song queue persistence keeps historical SQL representations private. */
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
const parseStoredCoordination = Schema.decodeUnknownEffect(Schema.Array(SongQueueCoordination));
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
    yield* sql`CREATE TABLE IF NOT EXISTS pending_requests (event_id TEXT PRIMARY KEY NOT NULL, track_id TEXT NOT NULL, track_name TEXT NOT NULL, artists TEXT NOT NULL, album TEXT NOT NULL, album_cover_url TEXT, requester_user_id TEXT NOT NULL, requester_display_name TEXT NOT NULL, requested_at TEXT NOT NULL, first_seen_in_spotify_at TEXT, last_seen_in_spotify_at TEXT)`;
    yield* sql`CREATE TABLE IF NOT EXISTS request_history (event_id TEXT PRIMARY KEY NOT NULL, track_id TEXT NOT NULL, track_name TEXT NOT NULL, artists TEXT NOT NULL, album TEXT NOT NULL, album_cover_url TEXT, requester_user_id TEXT NOT NULL, requester_display_name TEXT NOT NULL, requested_at TEXT NOT NULL, fulfilled_at TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS spotify_queue_snapshot (position INTEGER PRIMARY KEY NOT NULL, track_id TEXT NOT NULL, track_name TEXT NOT NULL, artists TEXT NOT NULL, album TEXT NOT NULL, album_cover_url TEXT, synced_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'autoplay', event_id TEXT, requester_user_id TEXT, requester_display_name TEXT, requested_at TEXT)`;
    // Adopt both baseline Drizzle revisions without replacing any historical row.
    const pendingColumns = yield* parseTableColumns(
      yield* sql`PRAGMA table_info(pending_requests)`,
    );
    if (!pendingColumns.some((column) => column.name === "first_seen_in_spotify_at"))
      yield* sql`ALTER TABLE pending_requests ADD COLUMN first_seen_in_spotify_at TEXT`;
    if (!pendingColumns.some((column) => column.name === "last_seen_in_spotify_at"))
      yield* sql`ALTER TABLE pending_requests ADD COLUMN last_seen_in_spotify_at TEXT`;
    const snapshotColumns = yield* parseTableColumns(
      yield* sql`PRAGMA table_info(spotify_queue_snapshot)`,
    );
    if (!snapshotColumns.some((column) => column.name === "source"))
      yield* sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN source TEXT NOT NULL DEFAULT 'autoplay'`;
    if (!snapshotColumns.some((column) => column.name === "event_id"))
      yield* sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN event_id TEXT`;
    if (!snapshotColumns.some((column) => column.name === "requester_user_id"))
      yield* sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN requester_user_id TEXT`;
    if (!snapshotColumns.some((column) => column.name === "requester_display_name"))
      yield* sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN requester_display_name TEXT`;
    if (!snapshotColumns.some((column) => column.name === "requested_at"))
      yield* sql`ALTER TABLE spotify_queue_snapshot ADD COLUMN requested_at TEXT`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_request_history_fulfilled_at ON request_history(fulfilled_at)`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_request_history_requester ON request_history(requester_user_id)`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_request_history_track ON request_history(track_id)`;
    yield* sql`CREATE TABLE song_queue_receipts (event_id TEXT PRIMARY KEY NOT NULL)`;
    yield* sql`INSERT OR IGNORE INTO song_queue_receipts SELECT event_id FROM pending_requests UNION SELECT event_id FROM request_history`;
    yield* sql`CREATE TABLE song_queue_coordination (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_sync_at REAL, refresh_due_at REAL NOT NULL, cleanup_due_at REAL NOT NULL, consecutive_sync_failures INTEGER NOT NULL)`;
    yield* sql`INSERT INTO song_queue_coordination VALUES (1, (SELECT (julianday(MAX(synced_at))-2440587.5)*86400000 FROM spotify_queue_snapshot), 0, 0, 0)`;
    const legacyTables = yield* parseStoredCount(
      yield* sql`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'`,
    );
    if ((legacyTables[0]?.count ?? 0) > 0) {
      const legacy = (yield* parseLegacyState(
        yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`,
      ))[0]?.state;
      if (legacy !== undefined) {
        yield* sql`UPDATE song_queue_coordination SET last_sync_at = ${legacy.lastSyncAt === null ? null : Date.parse(legacy.lastSyncAt)}, refresh_due_at = ${legacy.refreshDueAt === null ? 0 : Date.parse(legacy.refreshDueAt)}, cleanup_due_at = ${legacy.cleanupDueAt === null ? 0 : Date.parse(legacy.cleanupDueAt)}, consecutive_sync_failures = ${legacy.consecutiveSyncFailures} WHERE singleton = 1`;
      }
    }
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
const databaseFailure =
  (operation: string) =>
  <A, R>(
    effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | SongQueueError, R>,
  ): Effect.Effect<A, SongQueueError, R> =>
    effect.pipe(
      Effect.catchTags({
        SongQueueError: (error) => Effect.fail(error),
        SqlError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "storage_unavailable" })),
        SchemaError: () =>
          Effect.fail(new SongQueueError({ operation, reason: "stored_data_invalid" })),
      }),
    );

/** Construct song queue SQL operations after additive, transactional baseline adoption. */
export const makeSongQueueDatabase = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: songQueueMigrations, table: "song_queue_schema_migrations" });
  const sql = yield* SqlClient.SqlClient;
  const readOccurrences = Effect.fn("SongQueueDatabase.readOccurrences")(function* () {
    return (yield* parseStoredOccurrences(
      yield* sql`SELECT * FROM spotify_queue_snapshot ORDER BY position`,
    )).map(storedOccurrence);
  });
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
    persistRequest: Effect.fn("SongQueueDatabase.persistRequest")(function* (input) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const inserted =
            yield* sql`INSERT OR IGNORE INTO song_queue_receipts (event_id) VALUES (${input.eventId}) RETURNING event_id`;
          if (inserted.length === 0) return;
          yield* sql`INSERT INTO pending_requests (event_id, track_id, track_name, artists, album, album_cover_url, requester_user_id, requester_display_name, requested_at) VALUES (${input.eventId}, ${input.track.id}, ${input.track.name}, ${JSON.stringify(input.track.artists)}, ${input.track.album}, ${Option.getOrNull(input.track.albumCoverUrl)}, ${input.requesterUserId}, ${input.requesterDisplayName}, ${input.requestedAt})`;
          yield* sql`UPDATE song_queue_coordination SET last_sync_at = NULL, refresh_due_at = 0 WHERE singleton = 1`;
        }),
      );
    }, databaseFailure("persistRequest")),
    deleteRequest: Effect.fn("SongQueueDatabase.deleteRequest")(function* ({ eventId }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Keep a compensation tombstone so late workflow replay cannot resurrect the request.
          yield* sql`INSERT OR IGNORE INTO song_queue_receipts (event_id) VALUES (${eventId})`;
          yield* sql`DELETE FROM pending_requests WHERE event_id = ${eventId}`;
          yield* sql`UPDATE spotify_queue_snapshot SET source = 'autoplay', event_id = NULL, requester_user_id = NULL, requester_display_name = NULL, requested_at = NULL WHERE event_id = ${eventId}`;
        }),
      );
    }, databaseFailure("deleteRequest")),
    getCurrentlyPlaying: Effect.fn("SongQueueDatabase.getCurrentlyPlaying")(function* () {
      return {
        track: Option.fromUndefinedOr(
          (yield* readOccurrences()).find((item) => item.position === 0)?.track,
        ),
        position: 0 as const,
      };
    }, databaseFailure("getCurrentlyPlaying")),
    getSongQueue: Effect.fn("SongQueueDatabase.getSongQueue")(function* ({ limit }) {
      const upcoming = (yield* readOccurrences())
        .filter((item) => item.position > 0)
        .map((item) => item.track);
      const users = upcoming
        .filter((track) => track.source === "user")
        .toSorted((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
      return {
        tracks: [...users, ...upcoming.filter((track) => track.source === "autoplay")].slice(
          0,
          limit,
        ),
        totalCount: NonNegativeInt.make(upcoming.length),
      };
    }, databaseFailure("getSongQueue")),
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
    }, databaseFailure("getRequestHistory")),
    getUserRequestCount: Effect.fn("SongQueueDatabase.getUserRequestCount")(function* ({ userId }) {
      return storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE requester_user_id = ${userId}`,
        ),
      );
    }, databaseFailure("getUserRequestCount")),
    getUserRequestCountByDisplayName: Effect.fn(
      "SongQueueDatabase.getUserRequestCountByDisplayName",
    )(function* ({ displayName }) {
      return storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE requester_display_name = ${displayName}`,
        ),
      );
    }, databaseFailure("getUserRequestCountByDisplayName")),
    getSessionRequestCount: Effect.fn("SongQueueDatabase.getSessionRequestCount")(function* ({
      since,
    }) {
      return storedCount(
        yield* parseStoredCount(
          yield* sql`SELECT COUNT(*) AS count FROM request_history WHERE julianday(fulfilled_at) >= julianday(${since})`,
        ),
      );
    }, databaseFailure("getSessionRequestCount")),
    getTopTracks: Effect.fn("SongQueueDatabase.getTopTracks")(
      ({ limit }) => getTrackStatistics(Option.none(), limit),
      databaseFailure("getTopTracks"),
    ),
    getTopTracksByUser: Effect.fn("SongQueueDatabase.getTopTracksByUser")(
      ({ userId, limit }) => getTrackStatistics(Option.some(userId), limit),
      databaseFailure("getTopTracksByUser"),
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
    }, databaseFailure("getTopRequesters")),
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
    }, databaseFailure("checkDuplicateRequest")),
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
          const previousCurrent = previous.find((item) => item.position === 0)?.track;
          const nextCurrent = attributed.find((item) => item.position === 0)?.track;
          if (
            previousCurrent?.source === "user" &&
            (nextCurrent?.source !== "user" || previousCurrent.eventId !== nextCurrent.eventId)
          ) {
            yield* sql`INSERT OR IGNORE INTO request_history (event_id, track_id, track_name, artists, album, album_cover_url, requester_user_id, requester_display_name, requested_at, fulfilled_at) SELECT event_id, track_id, track_name, artists, album, album_cover_url, requester_user_id, requester_display_name, requested_at, ${syncedAt} FROM pending_requests WHERE event_id = ${previousCurrent.eventId}`;
            yield* sql`DELETE FROM pending_requests WHERE event_id = ${previousCurrent.eventId}`;
          }
          yield* sql`DELETE FROM spotify_queue_snapshot`;
          for (const { position, track } of attributed) {
            const eventId = track.source === "user" ? track.eventId : null;
            yield* sql`INSERT INTO spotify_queue_snapshot (position, track_id, track_name, artists, album, album_cover_url, synced_at, source, event_id, requester_user_id, requester_display_name, requested_at) VALUES (${position}, ${track.id}, ${track.name}, ${JSON.stringify(track.artists)}, ${track.album}, ${Option.getOrNull(track.albumCoverUrl)}, ${syncedAt}, ${track.source}, ${eventId}, ${track.source === "user" ? track.requesterUserId : null}, ${track.source === "user" ? track.requesterDisplayName : null}, ${track.source === "user" ? track.requestedAt : null})`;
            if (eventId !== null)
              yield* sql`UPDATE pending_requests SET first_seen_in_spotify_at = COALESCE(first_seen_in_spotify_at, ${syncedAt}), last_seen_in_spotify_at = ${syncedAt} WHERE event_id = ${eventId}`;
          }
          yield* sql`DELETE FROM pending_requests WHERE first_seen_in_spotify_at IS NOT NULL AND event_id NOT IN (SELECT event_id FROM spotify_queue_snapshot WHERE event_id IS NOT NULL)`;
          yield* sql`DELETE FROM pending_requests WHERE julianday(requested_at) < julianday(${syncedAt}) - (1.0 / 24)`;
          yield* sql`UPDATE song_queue_coordination SET last_sync_at = ${Date.parse(syncedAt)}, consecutive_sync_failures = 0 WHERE singleton = 1`;
        }),
      );
    }, databaseFailure("reconcilePlayback")),
    cleanupPending: Effect.fn("SongQueueDatabase.cleanupPending")(function* (before) {
      yield* sql`DELETE FROM pending_requests WHERE julianday(requested_at) < julianday(${before})`;
    }, databaseFailure("cleanupPending")),
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
    }, databaseFailure("getCoordination")),
    setCoordination: Effect.fn("SongQueueDatabase.setCoordination")(function* (input) {
      yield* sql`UPDATE song_queue_coordination SET last_sync_at = ${Option.getOrNull(input.lastSyncAt)}, refresh_due_at = ${input.refreshDueAt}, cleanup_due_at = ${input.cleanupDueAt}, consecutive_sync_failures = ${input.consecutiveSyncFailures} WHERE singleton = 1`;
    }, databaseFailure("setCoordination")),
  });
});

/** Song queue database Layer leaves the real SQL client requirement visible. */
export const songQueueDatabaseLayerWithoutDependencies = Layer.effect(
  SongQueueDatabase,
  makeSongQueueDatabase,
);
