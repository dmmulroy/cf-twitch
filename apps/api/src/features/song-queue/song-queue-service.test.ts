import { SqliteClient } from "@effect/sql-sqlite-node";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  BroadcasterId,
  IsoTimestamp,
  RedemptionId,
  RewardId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { ProviderError } from "@cf-twitch/contracts/provider";
import {
  PendingSongRequest,
  RequestHistoryQuery,
  SongQueueError,
  SongQueueLimit,
} from "@cf-twitch/contracts/song-queue";
import { Context, Deferred, Effect, Fiber, Layer, Option, Redacted, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import {
  providerTokenDatabaseLayerWithoutDependencies,
  TokenProviderIdentity,
} from "../providers/provider-token-database.ts";
import { providerTokenExchangeLayer } from "../providers/provider-token-exchange.ts";
import {
  ProviderTokenAlarm,
  ProviderTokenLifecycle,
  providerTokenLifecycleLayerWithoutDependencies,
} from "../providers/provider-token-lifecycle.ts";
import { spotifyServiceLayerWithoutDependencies } from "../providers/spotify-service.ts";
import { SongQueue } from "./song-queue.ts";
import { SongQueueAlarm } from "./song-queue-alarm.ts";
import {
  SongQueueDatabase,
  songQueueDatabaseLayerWithoutDependencies,
} from "./song-queue-database.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";
import { songQueueHttpHandlersLayer } from "./song-queue-http-handlers.ts";
import { SongQueueCoordinator, songQueueLayerWithoutDependencies } from "./song-queue-service.ts";

const songQueueLimit = (value: number): SongQueueLimit => SongQueueLimit.make(value);
const testTrack = {
  id: SpotifyTrackId.make("repeated"),
  name: "Repeated",
  artists: ["Artist"],
  album: "Album",
  albumCoverUrl: Option.none<string>(),
};
const pending = (id: string) =>
  PendingSongRequest.make({
    eventId: RedemptionId.make(id),
    track: testTrack,
    requesterUserId: ViewerId.make("viewer"),
    requesterDisplayName: "Viewer",
    requestedAt: IsoTimestamp.make("1970-01-01T00:00:00.000Z"),
  });
const historyQuery = RequestHistoryQuery.make({
  limit: songQueueLimit(100),
  offset: 0,
  since: Option.none<IsoTimestamp>(),
  until: Option.none<IsoTimestamp>(),
});
const providerTrack = {
  id: testTrack.id,
  name: testTrack.name,
  artists: [{ name: "Artist" }],
  album: { name: "Album", images: [] },
};
const PlaybackControl = Schema.Struct({
  current: Schema.Boolean,
  queueSize: Schema.Int,
  queueStatus: Schema.Int,
  currentStatus: Schema.Int,
});
type SongQueueObservationGate = {
  readonly queueStarted: Deferred.Deferred<void>;
  readonly currentStarted: Deferred.Deferred<void>;
  readonly releaseQueue: Deferred.Deferred<void>;
};
class SongQueueTestControl extends Context.Service<
  SongQueueTestControl,
  {
    readonly playback: Ref.Ref<typeof PlaybackControl.Type>;
    readonly requests: Ref.Ref<readonly string[]>;
    readonly alarms: Ref.Ref<readonly number[]>;
    readonly alarmFailure: Ref.Ref<boolean>;
    readonly observationGate: Ref.Ref<Option.Option<SongQueueObservationGate>>;
  }
>()("SongQueueTestControl") {}
const configurationLayer = Layer.succeed(TwitchConfiguration, {
  twitch: {
    clientId: "local",
    clientSecret: Redacted.make("local"),
    broadcaster: { id: BroadcasterId.make("1"), displayName: "Local" },
  },
  spotify: { clientId: "local", clientSecret: Redacted.make("local") },
  eventSubSecret: Redacted.make("local"),
  oauthSetupSecret: Redacted.make("local"),
  administratorSecret: Redacted.make("local"),
  rewardRouting: {
    songRequestRewardId: RewardId.make("song"),
    keyboardRaffleRewardId: RewardId.make("raffle"),
  },
});

// The only substituted resources are controlled HTTP and recorded alarms. Spotify parsing,
// token lifecycle, token SQL, song queue SQL, application policy and HTTP handlers are real.
const testLayer = Layer.unwrap(
  Effect.gen(function* () {
    const playback = yield* Ref.make<typeof PlaybackControl.Type>({
      current: false,
      queueSize: 0,
      queueStatus: 200,
      currentStatus: 200,
    });
    const requests = yield* Ref.make<readonly string[]>([]);
    const alarms = yield* Ref.make<readonly number[]>([]);
    const alarmFailure = yield* Ref.make(false);
    const observationGate = yield* Ref.make<Option.Option<SongQueueObservationGate>>(Option.none());
    const tokenAlarm = yield* Ref.make<Option.Option<number>>(Option.none());
    const transport = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (previous) => [
          ...previous,
          `${request.method} ${url.pathname}`,
        ]);
        const state = yield* Ref.get(playback);
        const gate = yield* Ref.get(observationGate);
        if (Option.isSome(gate) && url.pathname === "/v1/me/player/queue") {
          yield* Deferred.succeed(gate.value.queueStarted, undefined);
          yield* Deferred.await(gate.value.releaseQueue);
        }
        if (Option.isSome(gate) && url.pathname === "/v1/me/player/currently-playing")
          yield* Deferred.succeed(gate.value.currentStarted, undefined);
        const current = state.current ? providerTrack : null;
        if (url.pathname === "/v1/me/player/queue")
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                currently_playing: current,
                queue: Array.from({ length: state.queueSize }, () => providerTrack),
              },
              { status: state.queueStatus },
            ),
          );
        if (url.pathname === "/v1/me/player/currently-playing")
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { is_playing: state.current, item: current, progress_ms: 0 },
              { status: state.currentStatus },
            ),
          );
        return HttpClientResponse.fromWeb(
          request,
          new Response("Unconfigured controlled provider route", { status: 404 }),
        );
      }),
    );
    const httpLayer = Layer.succeed(HttpClient.HttpClient, transport);
    const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });
    const tokenLifecycleLayer = providerTokenLifecycleLayerWithoutDependencies.pipe(
      Layer.provide([
        providerTokenDatabaseLayerWithoutDependencies,
        providerTokenExchangeLayer.pipe(Layer.provide([httpLayer, configurationLayer])),
        Layer.succeed(ProviderTokenAlarm, {
          setAlarm: (at) => Ref.set(tokenAlarm, Option.some(at)),
          deleteAlarm: () => Ref.set(tokenAlarm, Option.none()),
        }),
      ]),
      Layer.provide(Layer.succeed(TokenProviderIdentity, "spotify")),
      Layer.provide(sqliteLayer),
    );
    const accessTokensLayer = Layer.effect(
      ProviderAccessTokens,
      Effect.gen(function* () {
        const lifecycle = yield* ProviderTokenLifecycle;
        yield* lifecycle.setTokens({
          accessToken: Redacted.make("local-access"),
          refreshToken: Option.some(Redacted.make("local-refresh")),
          tokenType: "Bearer",
          expiresIn: 86_400,
          scopes: [],
        });
        const selected = <A>(
          provider: "spotify" | "twitch",
          operation: Effect.Effect<A, ProviderError>,
        ) =>
          provider === "spotify"
            ? operation
            : Effect.fail(
                new ProviderError({
                  provider,
                  operation: "localTokenNamespace",
                  kind: "not-configured",
                  status: 0,
                  retryAfterMs: Option.none(),
                }),
              );
        return ProviderAccessTokens.of({
          getValidAccessToken: (provider) => selected(provider, lifecycle.getValidToken()),
          setTokens: (input) => selected(input.provider, lifecycle.setTokens(input.tokens)),
          onStreamOnline: (provider) => selected(provider, lifecycle.onStreamOnline()),
          onStreamOffline: (provider) => selected(provider, lifecycle.onStreamOffline()),
        });
      }),
    ).pipe(Layer.provide(tokenLifecycleLayer));
    const providerLayer = spotifyServiceLayerWithoutDependencies.pipe(
      Layer.provide([httpLayer, configurationLayer, accessTokensLayer, NodeCrypto.layer]),
    );
    const alarmLayer = Layer.succeed(SongQueueAlarm, {
      scheduleAlarm: (at) =>
        Effect.gen(function* () {
          if (yield* Ref.get(alarmFailure))
            return yield* new SongQueueError({
              operation: "scheduleAlarm",
              reason: "coordination_unavailable",
            });
          yield* Ref.update(alarms, (previous) => [...previous, at]);
        }),
    });
    const databaseLayer = songQueueDatabaseLayerWithoutDependencies.pipe(
      Layer.provideMerge(sqliteLayer),
    );
    return songQueueLayerWithoutDependencies.pipe(
      Layer.provide([providerLayer, alarmLayer]),
      Layer.provideMerge(databaseLayer),
      Layer.merge(
        Layer.succeed(SongQueueTestControl, {
          playback,
          requests,
          alarms,
          alarmFailure,
          observationGate,
        }),
      ),
    );
  }),
);

describe("Song queue service with real Spotify HTTP parsing and SQLite", () => {
  it.effect(
    "reconstructs missing deadlines from durable failures and caps outage polling at five minutes",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* SongQueueCoordinator;
        const database = yield* SongQueueDatabase;
        const control = yield* SongQueueTestControl;
        yield* database.setCoordination({
          lastSyncAt: Option.none(),
          refreshDueAt: 0,
          cleanupDueAt: 0,
          consecutiveSyncFailures: 6,
        });
        yield* coordinator.startPolling();
        expect(yield* database.getCoordination()).toMatchObject({
          refreshDueAt: 300_000,
          cleanupDueAt: 300_000,
          consecutiveSyncFailures: 6,
        });
        yield* Ref.update(control.playback, (state) => ({ ...state, queueStatus: 503 }));
        yield* TestClock.adjust(300_000);
        yield* coordinator.runAlarm();
        expect(yield* database.getCoordination()).toMatchObject({
          refreshDueAt: 600_000,
          cleanupDueAt: 600_000,
          consecutiveSyncFailures: 7,
        });
        yield* coordinator.startPolling();
        expect((yield* Ref.get(control.alarms)).at(-1)).toBe(600_000);
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "observes both Spotify endpoints concurrently while repeated tracks advance during an in-flight queue response",
    () =>
      Effect.gen(function* () {
        const queue = yield* SongQueue;
        const control = yield* SongQueueTestControl;
        yield* queue.persistRequest(pending("first"));
        yield* queue.persistRequest(pending("second"));
        yield* Ref.update(control.playback, (state) => ({ ...state, queueSize: 2 }));
        yield* queue.refreshQueue();
        const gate = {
          queueStarted: yield* Deferred.make<void>(),
          currentStarted: yield* Deferred.make<void>(),
          releaseQueue: yield* Deferred.make<void>(),
        };
        yield* Ref.set(control.observationGate, Option.some(gate));
        yield* Ref.update(control.playback, (state) => ({ ...state, current: true, queueSize: 1 }));
        const refreshing = yield* queue.refreshQueue().pipe(Effect.forkScoped);
        yield* Deferred.await(gate.queueStarted);
        yield* TestClock.adjust(1_000);
        expect(yield* Deferred.isDone(gate.currentStarted)).toBe(true);
        // Spotify advances again while its previous queue response remains in flight.
        yield* Ref.update(control.playback, (state) => ({ ...state, queueSize: 0 }));
        yield* Deferred.succeed(gate.releaseQueue, undefined);
        yield* Fiber.join(refreshing);
        yield* Ref.set(control.observationGate, Option.none());
        expect(Option.getOrThrow((yield* queue.getCurrentlyPlaying()).track)).toMatchObject({
          eventId: "first",
        });
        expect((yield* queue.getSongQueue({ limit: songQueueLimit(10) })).tracks[0]).toMatchObject({
          eventId: "second",
        });
        expect((yield* queue.getRequestHistory(historyQuery)).totalCount).toBe(0);
        yield* queue.refreshQueue();
        expect(Option.getOrThrow((yield* queue.getCurrentlyPlaying()).track)).toMatchObject({
          eventId: "second",
        });
        expect(
          (yield* queue.getRequestHistory(historyQuery)).requests.map((row) => row.eventId),
        ).toEqual(["first"]);
      }).pipe(Effect.provide(testLayer)),
  );
  it.effect(
    "invalidates mutation freshness, shares fresh reads for 15 seconds and keeps polling an empty offline queue",
    () =>
      Effect.gen(function* () {
        const queue = yield* SongQueue;
        const coordinator = yield* SongQueueCoordinator;
        const control = yield* SongQueueTestControl;
        yield* coordinator.startPolling();
        yield* queue.getSongQueue({ limit: songQueueLimit(100) });
        yield* queue.getCurrentlyPlaying();
        expect(yield* Ref.get(control.requests)).toHaveLength(2);
        yield* TestClock.adjust(14_999);
        yield* queue.getSongQueue({ limit: songQueueLimit(10) });
        expect(yield* Ref.get(control.requests)).toHaveLength(2);
        yield* TestClock.adjust(1);
        yield* coordinator.runAlarm();
        expect(yield* Ref.get(control.requests)).toHaveLength(4);
        expect((yield* Ref.get(control.alarms)).at(-1)).toBe(30_000);
        yield* Ref.update(control.playback, (state) => ({ ...state, queueSize: 1 }));
        yield* queue.persistRequest(pending("fresh"));
        const result = yield* queue.getSongQueue({ limit: songQueueLimit(10) });
        expect(result.tracks[0]).toMatchObject({ source: "user", eventId: "fresh" });
        expect(yield* Ref.get(control.requests)).toHaveLength(6);
        expect((yield* queue.getRequestHistory(historyQuery)).totalCount).toBe(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "preserves stale queue on authoritative queue failure, falls back to queue current evidence, and resets durable backoff",
    () =>
      Effect.gen(function* () {
        const queue = yield* SongQueue;
        const coordinator = yield* SongQueueCoordinator;
        const database = yield* SongQueueDatabase;
        const control = yield* SongQueueTestControl;
        yield* coordinator.startPolling();
        yield* Ref.update(control.playback, (state) => ({ ...state, current: true, queueSize: 1 }));
        yield* queue.refreshQueue();
        yield* TestClock.adjust(15_000);
        yield* Ref.update(control.playback, (state) => ({
          ...state,
          queueStatus: 503,
          current: false,
          queueSize: 0,
        }));
        const stale = yield* queue.getSongQueue({ limit: songQueueLimit(10) });
        expect(stale.tracks).toHaveLength(1);
        expect(yield* database.getCoordination()).toMatchObject({
          consecutiveSyncFailures: 1,
          refreshDueAt: 30_000,
        });
        yield* TestClock.adjust(15_000);
        yield* coordinator.runAlarm();
        expect(yield* database.getCoordination()).toMatchObject({
          consecutiveSyncFailures: 2,
          refreshDueAt: 60_000,
        });
        yield* Ref.update(control.playback, (state) => ({
          ...state,
          queueStatus: 200,
          currentStatus: 503,
          current: true,
        }));
        yield* queue.refreshQueue();
        expect(Option.getOrThrow((yield* queue.getCurrentlyPlaying()).track).id).toBe(testTrack.id);
        expect(yield* database.getCoordination()).toMatchObject({
          consecutiveSyncFailures: 0,
          refreshDueAt: 45_000,
        });
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "runs pending cleanup independently during provider outage and repairs scheduling failure from persisted intent",
    () =>
      Effect.gen(function* () {
        const queue = yield* SongQueue;
        const coordinator = yield* SongQueueCoordinator;
        const database = yield* SongQueueDatabase;
        const control = yield* SongQueueTestControl;
        yield* coordinator.startPolling();
        yield* Ref.set(control.alarmFailure, true);
        expect(
          yield* queue.persistRequest(pending("scheduleFailure")).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "coordination_unavailable" } });
        expect(
          yield* queue.checkDuplicateRequest({
            userId: ViewerId.make("viewer"),
            trackId: testTrack.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(true);
        yield* Ref.set(control.alarmFailure, false);
        yield* coordinator.startPolling();
        expect((yield* Ref.get(control.alarms)).at(-1)).toBe(1_000);
        yield* Ref.update(control.playback, (state) => ({ ...state, queueStatus: 503 }));
        yield* TestClock.adjust(3_600_001);
        yield* coordinator.runAlarm();
        expect(
          yield* queue.checkDuplicateRequest({
            userId: ViewerId.make("viewer"),
            trackId: testTrack.id,
            windowMinutes: songQueueLimit(100),
          }),
        ).toBe(false);
        expect((yield* database.getCoordination()).cleanupDueAt).toBe(3_900_001);
        expect((yield* Ref.get(control.alarms)).at(-1)).toBeGreaterThan(3_600_001);
        expect((yield* queue.getRequestHistory(historyQuery)).totalCount).toBe(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serializes concurrent stale reads", () =>
    Effect.gen(function* () {
      const queue = yield* SongQueue;
      const control = yield* SongQueueTestControl;
      yield* Effect.all(
        [
          queue.getSongQueue({ limit: songQueueLimit(10) }),
          queue.getCurrentlyPlaying(),
          queue.getSongQueue({ limit: songQueueLimit(5) }),
        ],
        { concurrency: "unbounded" },
      );
      expect(yield* Ref.get(control.requests)).toHaveLength(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains cleanup scheduling and the refresh lock after transactional snapshot failure",
    () =>
      Effect.gen(function* () {
        const queue = yield* SongQueue;
        const sql = yield* SqlClient.SqlClient;
        const control = yield* SongQueueTestControl;
        yield* Ref.update(control.playback, (state) => ({ ...state, queueSize: 1 }));
        yield* queue.getSongQueue({ limit: songQueueLimit(10) });
        yield* sql`CREATE TRIGGER fail_snapshot BEFORE INSERT ON spotify_queue_snapshot BEGIN SELECT RAISE(FAIL, 'snapshot unavailable'); END`;
        yield* TestClock.adjust(15_000);
        expect((yield* queue.getSongQueue({ limit: songQueueLimit(10) })).tracks).toHaveLength(1);
        yield* sql`DROP TRIGGER fail_snapshot`;
        yield* Ref.update(control.playback, (state) => ({ ...state, queueSize: 2 }));
        expect((yield* queue.getSongQueue({ limit: songQueueLimit(10) })).tracks).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "round-trips the real versioned HTTP API with Option payloads, history and typed failures",
    () =>
      Effect.gen(function* () {
        const queue = yield* SongQueue;
        const control = yield* SongQueueTestControl;
        const httpLayer = HttpApiBuilder.layer(SongQueueHttpApi).pipe(
          Layer.provide(songQueueHttpHandlersLayer),
          Layer.provide(Layer.succeed(SongQueue, queue)),
          Layer.provide(cloudflareHttpServerLayer),
        );
        const web = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(httpLayer, { disableLogger: true })),
          (server) => Effect.promise(() => server.dispose()),
        );
        const requestContext = yield* Effect.context<never>();
        const client = yield* HttpApiClient.makeWith(SongQueueHttpApi, {
          baseUrl: "http://song-queue.internal",
          httpClient: HttpClient.make((request) =>
            Effect.gen(function* () {
              const outgoing = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
              const response = yield* Effect.promise(() => web.handler(outgoing, requestContext));
              return HttpClientResponse.fromWeb(request, response);
            }),
          ),
        });
        const invalidLimitResponse = yield* Effect.promise(() =>
          web.handler(
            new Request("http://song-queue.internal/v1/queue", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ limit: 1_000 }),
            }),
            requestContext,
          ),
        );
        const invalidHistoryResponse = yield* Effect.promise(() =>
          web.handler(
            new Request("http://song-queue.internal/v1/history", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                limit: songQueueLimit(10),
                offset: 0,
                since: "1970-01-01T00:01:00Z",
                until: "1970-01-01T00:00:00Z",
              }),
            }),
            requestContext,
          ),
        );
        expect(invalidLimitResponse.status).toBe(400);
        expect(invalidHistoryResponse.status).toBe(400);
        expect(yield* Ref.get(control.requests)).toEqual([]);
        yield* client.songQueue.persistRequest({ payload: pending("http") });
        yield* Ref.update(control.playback, (state) => ({ ...state, queueSize: 1 }));
        expect(
          (yield* client.songQueue.getSongQueue({ payload: { limit: songQueueLimit(10) } }))
            .tracks[0],
        ).toMatchObject({ eventId: "http", albumCoverUrl: Option.none() });
        yield* Ref.update(control.playback, (state) => ({ ...state, current: true, queueSize: 0 }));
        yield* client.songQueue.refreshQueue();
        expect(
          Option.getOrThrow((yield* client.songQueue.getCurrentlyPlaying()).track),
        ).toMatchObject({ eventId: "http" });
        yield* Ref.update(control.playback, (state) => ({ ...state, current: false }));
        yield* client.songQueue.refreshQueue();
        expect(
          (yield* client.songQueue.getRequestHistory({ payload: historyQuery })).totalCount,
        ).toBe(1);
        yield* Ref.update(control.playback, (state) => ({ ...state, queueStatus: 503 }));
        expect(yield* client.songQueue.refreshQueue().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "SongQueueError", reason: "provider_unavailable" },
        });
        expect(yield* client.songQueue.getCurrentlyPlaying()).toEqual({
          track: Option.none(),
          position: 0,
        });
      }).pipe(Effect.provide(testLayer)),
  );
});
