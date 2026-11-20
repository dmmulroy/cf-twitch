import { Clock, Context, Effect, Layer, Option, Result, Semaphore } from "effect";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";
import { SpotifyService } from "../providers/spotify-service.ts";
import type { ISongQueue } from "./song-queue.ts";
import {
  SongQueueAlarm,
  songQueueAlarmLayer,
  songQueueAlarmTestLayer,
} from "./song-queue-alarm.ts";
import {
  SongQueueDatabase,
  songQueueDatabaseLayer,
  songQueueDatabaseTestLayer,
} from "./song-queue-database.ts";

/** Milliseconds a successful Spotify observation stays fresh before reads refresh it. */
const SONG_QUEUE_FRESHNESS_MS = 15_000;

/** Milliseconds between Pending Request cleanup passes. */
const SONG_QUEUE_CLEANUP_INTERVAL_MS = 300_000;

/** Milliseconds a never-observed Pending Request is retained. */
const SONG_QUEUE_PENDING_TTL_MS = 3_600_000;

/**
 * Song queue operations plus the Durable Object lifecycle hooks that drive durable refresh.
 *
 * **Details**
 *
 * `startPolling` and `runAlarm` are private to the `SongQueueDO` runtime; they are not exposed as
 * remote HTTP operations.
 */
export interface ISongQueueCoordinator extends ISongQueue {
  /**
   * Restores missing refresh and cleanup deadlines and installs the platform alarm.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage or alarm scheduling fails.
   */
  readonly startPolling: () => Effect.Effect<void, SongQueueError>;
  /**
   * Runs due Pending Request cleanup and Spotify refresh, then reinstalls the alarm.
   *
   * @returns Nothing, or fails with `SongQueueError` when storage or alarm scheduling fails; a
   *   Spotify failure is absorbed after its backoff is persisted.
   */
  readonly runAlarm: () => Effect.Effect<void, SongQueueError>;
}

/** Service that serializes Spotify observations with song queue mutations inside `SongQueueDO`. */
export class SongQueueCoordinator extends Context.Service<
  SongQueueCoordinator,
  ISongQueueCoordinator
>()("@cf-twitch/SongQueueCoordinator") {}

/** Returns the persisted exponential refresh backoff: 15s doubling per failure, capped at 300s. */
const songQueueRefreshBackoffMs = (consecutiveFailures: number): number =>
  Math.min(
    SONG_QUEUE_FRESHNESS_MS * 2 ** Math.min(consecutiveFailures - 1, 5),
    SONG_QUEUE_CLEANUP_INTERVAL_MS,
  );

/**
 * Creates the song queue coordinator over its database, Spotify provider, and alarm.
 *
 * **Details**
 *
 * One semaphore serializes refresh, cleanup, and request mutations. Request writes are
 * uninterruptible so a committed write always re-arms polling.
 *
 * @returns The coordinator service; its operations fail with `SongQueueError` as documented on
 *   `ISongQueueCoordinator`.
 */
export const makeSongQueueCoordinator = Effect.gen(function* () {
  const database = yield* SongQueueDatabase;
  const spotify = yield* SpotifyService;
  const alarm = yield* SongQueueAlarm;
  const withSongQueueLock = Semaphore.withPermit(yield* Semaphore.make(1));

  const armPolling = Effect.fn("SongQueueCoordinator.armPolling")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();
    yield* alarm.scheduleAlarm(
      Math.max(now + 1_000, Math.min(coordination.refreshDueAt, coordination.cleanupDueAt)),
    );
  });

  const syncPlayback = Effect.fn("SongQueueCoordinator.syncPlayback")(function* () {
    const observed = yield* spotify.getPlayback().pipe(
      Effect.catchTag("ProviderError", (error) =>
        Effect.logWarning("Song queue Spotify observation failed").pipe(
          Effect.annotateLogs({
            provider: error.provider,
            providerOperation: error.operation,
            providerFailure: error.kind,
            status: error.status,
          }),
          Effect.andThen(
            Effect.fail(
              new SongQueueError({ operation: "refreshQueue", reason: "provider_unavailable" }),
            ),
          ),
        ),
      ),
    );

    const now = yield* Clock.currentTimeMillis;
    yield* database.reconcilePlayback({
      currentlyPlaying: observed.currentlyPlaying,
      upcoming: observed.queue,
      syncedAt: IsoTimestamp.make(new Date(now).toISOString()),
    });
  });

  const refreshCycle = Effect.fn("SongQueueCoordinator.refreshCycle")(function* () {
    const result = yield* syncPlayback().pipe(Effect.result);
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();

    if (Result.isSuccess(result)) {
      yield* database.setCoordination({
        cleanupDueAt: coordination.cleanupDueAt,
        lastSyncAt: Option.some(now),
        refreshDueAt: now + SONG_QUEUE_FRESHNESS_MS,
        consecutiveSyncFailures: NonNegativeInt.make(0),
      });
    } else {
      const failures = coordination.consecutiveSyncFailures + 1;
      // The persisted failure counter, not a process-local Schedule driver, survives eviction.
      yield* database.setCoordination({
        lastSyncAt: coordination.lastSyncAt,
        cleanupDueAt: coordination.cleanupDueAt,
        refreshDueAt: now + songQueueRefreshBackoffMs(failures),
        consecutiveSyncFailures: NonNegativeInt.make(failures),
      });
      yield* Effect.logWarning("Song queue refresh failed; retaining stale snapshot").pipe(
        Effect.annotateLogs({
          operation: result.failure.operation,
          reason: result.failure.reason,
          consecutiveSyncFailures: failures,
        }),
      );
    }

    yield* armPolling();

    if (Result.isFailure(result)) return yield* result.failure;
  });

  const ensureFresh = Effect.fn("SongQueueCoordinator.ensureFresh")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();

    if (
      Option.isSome(coordination.lastSyncAt) &&
      now - coordination.lastSyncAt.value < SONG_QUEUE_FRESHNESS_MS
    )
      return;
    yield* refreshCycle().pipe(
      Effect.catchTag("SongQueueError", (error) =>
        Effect.logWarning("Song queue stale fallback used").pipe(
          Effect.annotateLogs({ operation: error.operation, reason: error.reason }),
        ),
      ),
    );
  }, withSongQueueLock);

  const startPolling = Effect.fn("SongQueueCoordinator.startPolling")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();
    yield* database.setCoordination({
      lastSyncAt: coordination.lastSyncAt,
      consecutiveSyncFailures: coordination.consecutiveSyncFailures,
      refreshDueAt:
        coordination.refreshDueAt > 0
          ? coordination.refreshDueAt
          : now +
            (coordination.consecutiveSyncFailures > 0
              ? songQueueRefreshBackoffMs(coordination.consecutiveSyncFailures)
              : 1_000),
      cleanupDueAt:
        coordination.cleanupDueAt > 0
          ? coordination.cleanupDueAt
          : now + SONG_QUEUE_CLEANUP_INTERVAL_MS,
    });
    yield* armPolling();
  }, withSongQueueLock);

  const runAlarm = Effect.fn("SongQueueCoordinator.runAlarm")(function* () {
    const now = yield* Clock.currentTimeMillis;
    let coordination = yield* database.getCoordination();

    if (coordination.cleanupDueAt <= now) {
      yield* database.cleanupPending(
        IsoTimestamp.make(new Date(now - SONG_QUEUE_PENDING_TTL_MS).toISOString()),
      );
      coordination = {
        lastSyncAt: coordination.lastSyncAt,
        consecutiveSyncFailures: coordination.consecutiveSyncFailures,
        refreshDueAt: coordination.refreshDueAt,
        cleanupDueAt: now + SONG_QUEUE_CLEANUP_INTERVAL_MS,
      };
      yield* database.setCoordination(coordination);
    }

    if (coordination.refreshDueAt <= now) {
      // Typed provider failure has already persisted backoff and installed the next alarm.
      yield* refreshCycle().pipe(
        Effect.catchIf(
          (error) => error.reason === "provider_unavailable",
          () => Effect.void,
        ),
      );
    } else yield* armPolling();
  }, withSongQueueLock);

  return SongQueueCoordinator.of({
    startPolling,
    runAlarm,
    refreshQueue: Effect.fn("SongQueueCoordinator.refreshQueue")(
      () => refreshCycle(),
      withSongQueueLock,
    ),
    persistRequest: Effect.fn("SongQueueCoordinator.persistRequest")(
      function* (input) {
        yield* database.persistRequest(input);
        yield* armPolling();
      },
      withSongQueueLock,
      Effect.uninterruptible,
    ),
    deleteRequest: Effect.fn("SongQueueCoordinator.deleteRequest")(
      function* (input) {
        yield* database.deleteRequest(input);
        yield* armPolling();
      },
      withSongQueueLock,
      Effect.uninterruptible,
    ),
    getSongQueue: Effect.fn("SongQueueCoordinator.getSongQueue")(function* (input) {
      yield* ensureFresh();

      return yield* database.getSongQueue(input);
    }),
    getCurrentlyPlaying: Effect.fn("SongQueueCoordinator.getCurrentlyPlaying")(function* () {
      yield* ensureFresh();

      return yield* database.getCurrentlyPlaying();
    }),
    getRequestHistory: database.getRequestHistory,
    getUserRequestCount: database.getUserRequestCount,
    getUserRequestCountByDisplayName: database.getUserRequestCountByDisplayName,
    getSessionRequestCount: database.getSessionRequestCount,
    getTopTracks: database.getTopTracks,
    getTopTracksByUser: database.getTopTracksByUser,
    getTopRequesters: database.getTopRequesters,
    checkDuplicateRequest: database.checkDuplicateRequest,
  });
});

/** Layer that provides the song queue coordinator, leaving database, alarm, and Spotify visible. */
export const songQueueCoordinatorLayerWithoutDependencies = Layer.effect(
  SongQueueCoordinator,
  makeSongQueueCoordinator,
);

/**
 * Layer that provides the song queue coordinator over SQLite storage and the platform alarm.
 *
 * **Details**
 *
 * The Durable Object's SQL client and state, and the Spotify provider captured during outer
 * initialization, stay visible for the `SongQueueDO` runtime to supply.
 */
export const songQueueCoordinatorLayer = songQueueCoordinatorLayerWithoutDependencies.pipe(
  Layer.provide([songQueueDatabaseLayer, songQueueAlarmLayer]),
);

/**
 * Layer that provides the song queue coordinator over in-memory storage and alarm test Layers.
 *
 * **Details**
 *
 * The Spotify provider stays a visible requirement so each test selects a controlled provider.
 */
export const songQueueCoordinatorTestLayer = songQueueCoordinatorLayerWithoutDependencies.pipe(
  Layer.provide([songQueueDatabaseTestLayer, songQueueAlarmTestLayer]),
);
