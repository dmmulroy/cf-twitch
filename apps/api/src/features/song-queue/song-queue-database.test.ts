import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import {
  PendingSongRequest,
  RequestHistoryQuery,
  SongQueueLimit,
} from "@cf-twitch/contracts/song-queue";
import type { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import {
  SongQueueDatabase,
  songQueueDatabaseLayerWithoutDependencies,
} from "./song-queue-database.ts";

const sqlLayer = SqliteClient.layer({ filename: ":memory:" });
const songQueueLimit = (value: number): SongQueueLimit => SongQueueLimit.make(value);
const databaseLayer = songQueueDatabaseLayerWithoutDependencies.pipe(Layer.provideMerge(sqlLayer));
const instant = (seconds: number) => IsoTimestamp.make(new Date(seconds * 1000).toISOString());
const track = (id: string, name = id): SpotifyTrack => ({
  id: SpotifyTrackId.make(id),
  name,
  artists: [name],
  album: "Album",
  albumCoverUrl: Option.none(),
});
const request = (
  id: string,
  song = track("repeat"),
  seconds = 0,
  viewer = "viewer",
  displayName = "Viewer",
) =>
  PendingSongRequest.make({
    eventId: RedemptionId.make(id),
    track: song,
    requestedAt: instant(seconds),
    requesterUserId: ViewerId.make(viewer),
    requesterDisplayName: displayName,
  });
const historyQuery = RequestHistoryQuery.make({
  limit: songQueueLimit(100),
  offset: 0,
  since: Option.none<IsoTimestamp>(),
  until: Option.none<IsoTimestamp>(),
});
const snapshot = (
  current: Option.Option<SpotifyTrack>,
  upcoming: readonly SpotifyTrack[],
  seconds: number,
) => ({ currentlyPlaying: current, upcoming, syncedAt: instant(seconds) });
const playRequest = Effect.fn("SongQueueTest.playRequest")(function* (
  pending: PendingSongRequest,
  seconds: number,
) {
  const database = yield* SongQueueDatabase;
  yield* database.persistRequest(pending);
  yield* database.reconcilePlayback(snapshot(Option.none(), [pending.track], seconds));
  yield* database.reconcilePlayback(snapshot(Option.some(pending.track), [], seconds + 1));
  yield* database.reconcilePlayback(snapshot(Option.none(), [], seconds + 2));
});

describe("Song queue real SQLite persistence", () => {
  it.effect(
    "attributes repeated occurrences and records only the previous current request leaving playback",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const first = request("first");
        const second = request("second", first.track, 1);
        yield* database.persistRequest(first);
        yield* database.persistRequest(second);
        yield* database.reconcilePlayback(
          snapshot(Option.some(track("autoplay")), [first.track, first.track], 10),
        );
        expect((yield* database.getRequestHistory(historyQuery)).totalCount).toBe(0);
        yield* database.reconcilePlayback(snapshot(Option.some(first.track), [first.track], 20));
        expect(Option.getOrThrow((yield* database.getCurrentlyPlaying()).track)).toMatchObject({
          eventId: first.eventId,
        });
        expect((yield* database.getSongQueue({ limit: songQueueLimit(100) })).tracks).toMatchObject(
          [{ eventId: second.eventId }],
        );
        yield* database.reconcilePlayback(snapshot(Option.some(first.track), [], 30));
        expect(Option.getOrThrow((yield* database.getCurrentlyPlaying()).track)).toMatchObject({
          eventId: second.eventId,
        });
        expect(
          (yield* database.getRequestHistory(historyQuery)).requests.map((row) => row.eventId),
        ).toEqual([first.eventId]);
        yield* database.reconcilePlayback(snapshot(Option.none(), [], 40));
        yield* database.reconcilePlayback(snapshot(Option.none(), [], 50));
        expect(
          (yield* database.getRequestHistory(historyQuery)).requests.map((row) => row.eventId),
        ).toEqual([second.eventId, first.eventId]);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "does not steal the currently playing autoplay occurrence for a newly requested repeated track",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const pending = request("new");
        yield* database.reconcilePlayback(snapshot(Option.some(pending.track), [], 1));
        yield* database.persistRequest(pending);
        yield* database.reconcilePlayback(snapshot(Option.some(pending.track), [], 2));
        expect(Option.getOrThrow((yield* database.getCurrentlyPlaying()).track).source).toBe(
          "autoplay",
        );
        yield* database.reconcilePlayback(snapshot(Option.some(pending.track), [pending.track], 3));
        expect(
          (yield* database.getSongQueue({ limit: songQueueLimit(1) })).tracks[0],
        ).toMatchObject({
          source: "user",
          eventId: pending.eventId,
        });
        yield* database.reconcilePlayback(snapshot(Option.some(pending.track), [], 4));
        expect(Option.getOrThrow((yield* database.getCurrentlyPlaying()).track)).toMatchObject({
          eventId: pending.eventId,
        });
        expect((yield* database.getRequestHistory(historyQuery)).totalCount).toBe(0);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "drops disappeared upcoming requests without history and retains never-seen requests exactly one hour",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const seen = request("seen", track("seen"));
        const unseen = request("unseen", track("unseen"));
        yield* database.persistRequest(seen);
        yield* database.persistRequest(unseen);
        yield* database.reconcilePlayback(snapshot(Option.none(), [seen.track], 1));
        yield* database.reconcilePlayback(snapshot(Option.none(), [], 2));
        expect(
          yield* database.checkDuplicateRequest({
            userId: seen.requesterUserId,
            trackId: seen.track.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(false);
        expect(
          yield* database.checkDuplicateRequest({
            userId: unseen.requesterUserId,
            trackId: unseen.track.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(true);
        yield* database.cleanupPending(instant(0));
        expect(
          yield* database.checkDuplicateRequest({
            userId: unseen.requesterUserId,
            trackId: unseen.track.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(true);
        yield* database.cleanupPending(instant(1));
        expect(
          yield* database.checkDuplicateRequest({
            userId: unseen.requesterUserId,
            trackId: unseen.track.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(false);
        expect((yield* database.getRequestHistory(historyQuery)).totalCount).toBe(0);
        // Durable receipt prevents a workflow redelivery resurrecting a dropped request.
        yield* database.persistRequest(seen);
        expect(
          yield* database.checkDuplicateRequest({
            userId: seen.requesterUserId,
            trackId: seen.track.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(false);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "orders requested FIFO before autoplay while preserving total count and large queue positions",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const early = request("early", track("early"), 0);
        const late = request("late", track("late"), 2);
        yield* database.persistRequest(late);
        yield* database.persistRequest(early);
        yield* database.reconcilePlayback(
          snapshot(
            Option.none(),
            [
              track("auto"),
              late.track,
              early.track,
              ...Array.from({ length: 50 }, (_, i) => track(`auto${i}`)),
            ],
            4,
          ),
        );
        const result = yield* database.getSongQueue({ limit: songQueueLimit(3) });
        expect(result.totalCount).toBe(53);
        expect(result.tracks.map((song) => song.id)).toEqual([
          early.track.id,
          late.track.id,
          "auto",
        ]);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "deduplicates played and compensated receipts, including compensation arriving before persistence",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const pending = request("once");
        yield* playRequest(pending, 1);
        yield* database.persistRequest(pending);
        yield* database.reconcilePlayback(snapshot(Option.none(), [pending.track], 10));
        expect(
          (yield* database.getSongQueue({ limit: songQueueLimit(10) })).tracks[0]?.source,
        ).toBe("autoplay");
        expect((yield* database.getRequestHistory(historyQuery)).totalCount).toBe(1);
        const canceled = request("canceled");
        yield* database.deleteRequest({ eventId: canceled.eventId });
        yield* database.persistRequest(canceled);
        yield* database.deleteRequest({ eventId: canceled.eventId });
        yield* database.reconcilePlayback(
          snapshot(Option.none(), [pending.track, canceled.track], 20),
        );
        expect(
          (yield* database.getSongQueue({ limit: songQueueLimit(10) })).tracks.every(
            (song) => song.source === "autoplay",
          ),
        ).toBe(true);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "aggregates stable track/viewer IDs with latest names, pagination, inclusive offset dates and session counts",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        yield* playRequest(
          request("old", track("stable", "Old title"), 0, "viewer", "Old name"),
          10,
        );
        yield* playRequest(
          request("new", track("stable", "New title"), 20, "viewer", "New name"),
          20,
        );
        yield* playRequest(request("other", track("other"), 30, "other-viewer", "Other"), 30);
        expect(yield* database.getTopTracks({ limit: songQueueLimit(10) })).toEqual([
          { trackId: "stable", trackName: "New title", artists: ["New title"], requestCount: 2 },
          { trackId: "other", trackName: "other", artists: ["other"], requestCount: 1 },
        ]);
        expect(yield* database.getTopRequesters({ limit: songQueueLimit(1) })).toEqual([
          { userId: "viewer", displayName: "New name", requestCount: 2 },
        ]);
        expect(
          yield* database.getTopTracksByUser({
            userId: ViewerId.make("viewer"),
            limit: songQueueLimit(10),
          }),
        ).toHaveLength(1);
        expect(yield* database.getUserRequestCount({ userId: ViewerId.make("viewer") })).toBe(2);
        expect(yield* database.getUserRequestCountByDisplayName({ displayName: "Old name" })).toBe(
          1,
        );
        expect(yield* database.getSessionRequestCount({ since: instant(22) })).toBe(2);
        const filtered = yield* database.getRequestHistory(
          RequestHistoryQuery.make({
            ...historyQuery,
            since: Option.some(IsoTimestamp.make("1970-01-01T01:00:22+01:00")),
            until: Option.some(instant(32)),
            limit: songQueueLimit(1),
            offset: 1,
          }),
        );
        expect(filtered.totalCount).toBe(2);
        expect(filtered.requests[0]?.eventId).toBe("new");
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "rolls back history, pending attribution and the entire snapshot when an insertion fails",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const sql = yield* SqlClient.SqlClient;
        const pending = request("atomic");
        yield* database.persistRequest(pending);
        yield* database.reconcilePlayback(snapshot(Option.none(), [pending.track], 1));
        yield* database.reconcilePlayback(snapshot(Option.some(pending.track), [], 2));
        yield* sql`CREATE TRIGGER fail_snapshot BEFORE INSERT ON spotify_queue_snapshot BEGIN SELECT RAISE(FAIL, 'snapshot insert failed'); END`;
        const result = yield* database
          .reconcilePlayback(snapshot(Option.some(track("next")), [], 3))
          .pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "storage_unavailable" },
        });
        expect((yield* database.getRequestHistory(historyQuery)).totalCount).toBe(0);
        expect(Option.getOrThrow((yield* database.getCurrentlyPlaying()).track)).toMatchObject({
          eventId: pending.eventId,
        });
        yield* sql`DROP TRIGGER fail_snapshot`;
        yield* database.reconcilePlayback(snapshot(Option.some(track("next")), [], 4));
        expect((yield* database.getRequestHistory(historyQuery)).totalCount).toBe(1);
      }).pipe(Effect.provide(databaseLayer)),
  );

  it.effect(
    "returns typed stored-data failures instead of trusting corrupt serialized artist metadata",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        const sql = yield* SqlClient.SqlClient;
        yield* playRequest(request("corrupt"), 1);
        yield* sql`UPDATE request_history SET artists = 'not-json'`;
        expect(yield* database.getRequestHistory(historyQuery).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "stored_data_invalid" },
        });
      }).pipe(Effect.provide(databaseLayer)),
  );
});

const legacySeedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE pending_requests (event_id TEXT PRIMARY KEY, track_id TEXT, track_name TEXT, artists TEXT, album TEXT, album_cover_url TEXT, requester_user_id TEXT, requester_display_name TEXT, requested_at TEXT)`;
    yield* sql`INSERT INTO pending_requests VALUES ('legacy-request', 'legacytrack', 'Legacy title', '["Artist"]', 'Album', NULL, 'viewer', 'Viewer', '1970-01-01T00:00:00.000Z')`;
    yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY, state TEXT)`;
    yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', ${JSON.stringify({ lastSyncAt: "1970-01-01T00:00:05.000Z", refreshScheduleId: "opaque-old-id", refreshDueAt: "1970-01-01T00:00:20.000Z", cleanupScheduleId: null, cleanupDueAt: null, consecutiveSyncFailures: 3 })})`;
  }),
);
const adoptedLayer = songQueueDatabaseLayerWithoutDependencies.pipe(
  Layer.provide(legacySeedLayer),
  Layer.provideMerge(sqlLayer),
);

const legacyPlaybackLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE pending_requests ADD COLUMN first_seen_in_spotify_at TEXT`;
    yield* sql`ALTER TABLE pending_requests ADD COLUMN last_seen_in_spotify_at TEXT`;
    yield* sql`UPDATE pending_requests SET first_seen_in_spotify_at = '1970-01-01T00:00:01.000Z', last_seen_in_spotify_at = '1970-01-01T00:00:05.000Z'`;
    yield* sql`CREATE TABLE spotify_queue_snapshot (position INTEGER PRIMARY KEY, track_id TEXT, track_name TEXT, artists TEXT, album TEXT, album_cover_url TEXT, synced_at TEXT, source TEXT, event_id TEXT, requester_user_id TEXT, requester_display_name TEXT, requested_at TEXT)`;
    yield* sql`INSERT INTO spotify_queue_snapshot VALUES (0, 'legacytrack', 'Legacy title', '["Artist"]', 'Album', NULL, '1970-01-01T00:00:05.000Z', 'user', 'legacy-request', 'viewer', 'Viewer', '1970-01-01T00:00:00.000Z')`;
    yield* sql`CREATE TABLE request_history (event_id TEXT PRIMARY KEY, track_id TEXT, track_name TEXT, artists TEXT, album TEXT, album_cover_url TEXT, requester_user_id TEXT, requester_display_name TEXT, requested_at TEXT, fulfilled_at TEXT)`;
    yield* sql`INSERT INTO request_history VALUES ('earlier-play', 'earliertrack', 'Earlier title', '["Artist"]', 'Album', NULL, 'viewer', 'Viewer', '1969-12-31T23:58:00.000Z', '1969-12-31T23:59:00.000Z')`;
  }),
).pipe(Layer.provide(legacySeedLayer));
const adoptedPlaybackLayer = songQueueDatabaseLayerWithoutDependencies.pipe(
  Layer.provide(legacyPlaybackLayer),
  Layer.provideMerge(sqlLayer),
);

describe("Song queue historical adoption", () => {
  it.effect(
    "retains legacy current occurrence and history across migration and restart before recording playback departure",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        expect(Option.getOrThrow((yield* database.getCurrentlyPlaying()).track)).toMatchObject({
          source: "user",
          eventId: "legacy-request",
        });
        expect(
          (yield* database.getRequestHistory(historyQuery)).requests.map((row) => row.eventId),
        ).toEqual(["earlier-play"]);
        const restarted = yield* Effect.gen(function* () {
          const rebuilt = yield* SongQueueDatabase;
          return yield* rebuilt.getCoordination();
        }).pipe(Effect.provide(songQueueDatabaseLayerWithoutDependencies));
        expect(restarted).toEqual(yield* database.getCoordination());
        yield* database.reconcilePlayback(snapshot(Option.none(), [], 6));
        expect(
          (yield* database.getRequestHistory(historyQuery)).requests.map((row) => row.eventId),
        ).toEqual(["legacy-request", "earlier-play"]);
      }).pipe(Effect.provide(adoptedPlaybackLayer)),
  );

  it.effect("blocks malformed legacy Agent state transactionally rather than resetting it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY, state TEXT)`;
      yield* sql`INSERT INTO cf_agents_state VALUES ('cf_state_row_id', 'not-json')`;
      const result = yield* Effect.gen(function* () {
        yield* SongQueueDatabase;
      }).pipe(Effect.provide(songQueueDatabaseLayerWithoutDependencies), Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(yield* sql`SELECT state FROM cf_agents_state`).toEqual([{ state: "not-json" }]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'song_queue_coordination'`,
      ).toEqual([]);
    }).pipe(Effect.provide(sqlLayer)),
  );

  it.effect(
    "adopts historical SQL without clearing requests and preserves Agent freshness/backoff/deadlines without schedule IDs",
    () =>
      Effect.gen(function* () {
        const database = yield* SongQueueDatabase;
        expect(yield* database.getCoordination()).toEqual({
          lastSyncAt: Option.some(5_000),
          refreshDueAt: 20_000,
          cleanupDueAt: 0,
          consecutiveSyncFailures: 3,
        });
        expect(
          yield* database.checkDuplicateRequest({
            userId: ViewerId.make("viewer"),
            trackId: SpotifyTrackId.make("legacytrack"),
            windowMinutes: songQueueLimit(30),
          }),
        ).toBe(true);
        yield* database.reconcilePlayback(snapshot(Option.none(), [track("legacytrack")], 6));
        expect(
          (yield* database.getSongQueue({ limit: songQueueLimit(10) })).tracks[0],
        ).toMatchObject({
          eventId: "legacy-request",
          source: "user",
        });
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT state FROM cf_agents_state`;
        expect(rows).toHaveLength(1);
      }).pipe(Effect.provide(adoptedLayer)),
  );
});
