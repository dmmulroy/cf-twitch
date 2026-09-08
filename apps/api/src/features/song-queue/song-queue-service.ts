import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";
import { SongQueueError } from "@cf-twitch/contracts/song-queue";
import { SpotifyService } from "../providers/spotify-service.ts";
import { SongQueue, type ISongQueue } from "./song-queue.ts";
import { SongQueueAlarm } from "./song-queue-alarm.ts";
import { SongQueueDatabase } from "./song-queue-database.ts";

/** Song queue lifecycle methods are private to the Durable Object, not remote mutation APIs. */
export interface ISongQueueCoordinator extends ISongQueue {
  readonly startPolling: () => Effect.Effect<void, SongQueueError>;
  readonly runAlarm: () => Effect.Effect<void, SongQueueError>;
}
/** Song queue coordinator serializes provider observations with request mutations. */
export class SongQueueCoordinator extends Context.Service<
  SongQueueCoordinator,
  ISongQueueCoordinator
>()("@cf-twitch/SongQueueCoordinator") {}

/** Construct song queue policy with a durable database, Spotify provider and alarm requirement. */
export const makeSongQueue = Effect.gen(function* () {
  const database = yield* SongQueueDatabase;
  const spotify = yield* SpotifyService;
  const alarm = yield* SongQueueAlarm;
  const lock = yield* Semaphore.make(1);
  const withSongQueueLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect);

  const armPolling = Effect.fn("SongQueue.armPolling")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();
    yield* alarm.scheduleAlarm(
      Math.max(now + 1_000, Math.min(coordination.refreshDueAt, coordination.cleanupDueAt)),
    );
  });
  const syncPlayback = Effect.fn("SongQueue.syncPlayback")(function* () {
    const observed = yield* spotify.getPlayback().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Song queue Spotify observation failed").pipe(
          Effect.annotateLogs({
            provider: error.provider,
            providerOperation: error.operation,
            providerFailure: error.kind,
            status: error.status,
          }),
        ),
      ),
      Effect.mapError(
        () => new SongQueueError({ operation: "refreshQueue", reason: "provider_unavailable" }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    yield* database.reconcilePlayback({
      currentlyPlaying: observed.currentlyPlaying,
      upcoming: observed.queue,
      syncedAt: IsoTimestamp.make(new Date(now).toISOString()),
    });
  });
  const refreshCycle = Effect.fn("SongQueue.refreshCycle")(function* () {
    const result = yield* syncPlayback().pipe(Effect.result);
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();
    if (result._tag === "Success") {
      yield* database.setCoordination({
        cleanupDueAt: coordination.cleanupDueAt,
        lastSyncAt: Option.some(now),
        refreshDueAt: now + 15_000,
        consecutiveSyncFailures: NonNegativeInt.make(0),
      });
    } else {
      const failures = coordination.consecutiveSyncFailures + 1;
      // The persisted failure counter, not a process-local Schedule driver, survives eviction.
      const delay = Math.min(15_000 * 2 ** Math.min(failures - 1, 5), 300_000);
      yield* database.setCoordination({
        lastSyncAt: coordination.lastSyncAt,
        cleanupDueAt: coordination.cleanupDueAt,
        refreshDueAt: now + delay,
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
    if (result._tag === "Failure") return yield* result.failure;
  });
  const ensureFresh = Effect.fn("SongQueue.ensureFresh")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const coordination = yield* database.getCoordination();
    if (Option.isSome(coordination.lastSyncAt) && now - coordination.lastSyncAt.value < 15_000)
      return;
    yield* refreshCycle().pipe(
      Effect.catchTag("SongQueueError", (error) =>
        Effect.logWarning("Song queue stale fallback used").pipe(
          Effect.annotateLogs({ operation: error.operation, reason: error.reason }),
        ),
      ),
    );
  }, withSongQueueLock);
  const startPolling = Effect.fn("SongQueue.startPolling")(function* () {
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
              ? Math.min(
                  15_000 * 2 ** Math.min(coordination.consecutiveSyncFailures - 1, 5),
                  300_000,
                )
              : 1_000),
      cleanupDueAt: coordination.cleanupDueAt > 0 ? coordination.cleanupDueAt : now + 300_000,
    });
    yield* armPolling();
  }, withSongQueueLock);
  const runAlarm = Effect.fn("SongQueue.runAlarm")(function* () {
    const now = yield* Clock.currentTimeMillis;
    let coordination = yield* database.getCoordination();
    if (coordination.cleanupDueAt <= now) {
      yield* database.cleanupPending(IsoTimestamp.make(new Date(now - 3_600_000).toISOString()));
      coordination = {
        lastSyncAt: coordination.lastSyncAt,
        consecutiveSyncFailures: coordination.consecutiveSyncFailures,
        refreshDueAt: coordination.refreshDueAt,
        cleanupDueAt: now + 300_000,
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
    refreshQueue: Effect.fn("SongQueue.refreshQueue")(() => refreshCycle(), withSongQueueLock),
    persistRequest: Effect.fn("SongQueue.persistRequest")(
      function* (input) {
        yield* database.persistRequest(input);
        yield* armPolling();
      },
      withSongQueueLock,
      Effect.uninterruptible,
    ),
    deleteRequest: Effect.fn("SongQueue.deleteRequest")(
      function* (input) {
        yield* database.deleteRequest(input);
        yield* armPolling();
      },
      withSongQueueLock,
      Effect.uninterruptible,
    ),
    getSongQueue: Effect.fn("SongQueue.getSongQueue")(function* (input) {
      yield* ensureFresh();
      return yield* database.getSongQueue(input);
    }),
    getCurrentlyPlaying: Effect.fn("SongQueue.getCurrentlyPlaying")(function* () {
      yield* ensureFresh();
      return yield* database.getCurrentlyPlaying();
    }),
    getRequestHistory: Effect.fn("SongQueue.getRequestHistory")((input) =>
      database.getRequestHistory(input),
    ),
    getUserRequestCount: Effect.fn("SongQueue.getUserRequestCount")((input) =>
      database.getUserRequestCount(input),
    ),
    getUserRequestCountByDisplayName: Effect.fn("SongQueue.getUserRequestCountByDisplayName")(
      (input) => database.getUserRequestCountByDisplayName(input),
    ),
    getSessionRequestCount: Effect.fn("SongQueue.getSessionRequestCount")((input) =>
      database.getSessionRequestCount(input),
    ),
    getTopTracks: Effect.fn("SongQueue.getTopTracks")((input) => database.getTopTracks(input)),
    getTopTracksByUser: Effect.fn("SongQueue.getTopTracksByUser")((input) =>
      database.getTopTracksByUser(input),
    ),
    getTopRequesters: Effect.fn("SongQueue.getTopRequesters")((input) =>
      database.getTopRequesters(input),
    ),
    checkDuplicateRequest: Effect.fn("SongQueue.checkDuplicateRequest")((input) =>
      database.checkDuplicateRequest(input),
    ),
  });
});

/** Provide the same song queue implementation to HTTP handlers and alarm lifecycle. */
export const songQueueLayerWithoutDependencies = Layer.effectContext(
  Effect.gen(function* () {
    const queue = yield* makeSongQueue;
    return Context.make(SongQueue, queue).pipe(Context.add(SongQueueCoordinator, queue));
  }),
);
