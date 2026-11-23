import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Match, Option, Ref, Schema } from "effect";
import type { DomainEvent } from "@cf-twitch/contracts/domain-event";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import { EventId, IsoTimestamp, NonNegativeInt, StreamId } from "@cf-twitch/contracts/identity";
import { EventPublisher } from "../events/event-publisher.ts";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { StreamAlarm, streamAlarmTestLayer } from "./stream-alarm.ts";
import {
  StreamDatabase,
  type IStreamDatabase,
  streamDatabaseTestLayer,
} from "./stream-database.ts";
import { StreamLifecycle, streamLifecycleLayerWithoutDependencies } from "./stream-lifecycle.ts";
import {
  StreamLifecycleClient,
  streamLifecycleClientTestLayer,
} from "./stream-lifecycle-client.ts";
import { initialStreamState } from "./stream-state.ts";
import { StreamViewerProvider, streamViewerProviderTestLayer } from "./stream-viewer-provider.ts";
import type { TwitchStreamInfo } from "@cf-twitch/contracts/provider";

const startedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T11:55:00.000Z");

const streamId = Schema.decodeUnknownSync(StreamId)("stream-123");

/** Describes a published lifecycle event by type, stream, and transition time. */
const describeLifecycleEvent = (event: DomainEvent): string =>
  Match.value(event).pipe(
    Match.when({ type: "stream_online" }, (online) =>
      ["stream_online", online.streamId, online.startedAt].join(":"),
    ),
    Match.when({ type: "stream_offline" }, (offline) =>
      ["stream_offline", offline.streamId, offline.endedAt].join(":"),
    ),
    Match.orElse((other) => other.type),
  );

describe("Stream Lifecycle", () => {
  it.effect("resumes the same transition event from partial durable checkpoints", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialStreamState());
      const tokenCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const publishedIds = yield* Ref.make<ReadonlyArray<EventId>>([]);
      const publicationAttempts = yield* Ref.make(0);
      const alarmCalls = yield* Ref.make(0);

      const database: IStreamDatabase = {
        getState: () => Ref.get(state),
        saveState: (next) => Ref.set(state, next),
        recordViewerCount: (input) => Effect.succeed(input.state),
        getViewerHistory: () => Effect.succeed({ snapshots: [], totalCount: 0 }),
        getViewerSnapshotCount: () => Effect.succeed(0),
        reset: () => Ref.set(state, initialStreamState()).pipe(Effect.as(initialStreamState())),
      };

      const layer = streamLifecycleLayerWithoutDependencies.pipe(
        Layer.provide(Layer.succeed(StreamDatabase, StreamDatabase.of(database))),
        Layer.provide(
          Layer.succeed(
            ProviderAccessTokens,
            ProviderAccessTokens.of({
              getValidAccessToken: () => Effect.die("not used"),
              setTokens: () => Effect.die("not used"),
              onStreamOnline: (provider) =>
                Ref.update(tokenCalls, (calls) => [...calls, `online:${provider}`]),
              onStreamOffline: (provider) =>
                Ref.update(tokenCalls, (calls) => [...calls, `offline:${provider}`]),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            EventPublisher,
            EventPublisher.of({
              publish: (event) =>
                Effect.gen(function* () {
                  yield* Ref.update(publishedIds, (ids) => [...ids, event.id]);

                  const attempt = yield* Ref.getAndUpdate(
                    publicationAttempts,
                    (value) => value + 1,
                  );

                  if (attempt === 0) {
                    return yield* new EventBusError({
                      operation: "publish",
                      reason: "subscriber_unavailable",
                      eventId: Option.some(event.id),
                    });
                  }
                }),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            StreamAlarm,
            StreamAlarm.of({
              scheduleAt: () => Ref.update(alarmCalls, (calls) => calls + 1),
              clear: () => Effect.void,
            }),
          ),
        ),
        Layer.provide(streamViewerProviderTestLayer),
        Layer.provide(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const stream = yield* StreamLifecycle;
        const first = yield* Effect.result(stream.markOnline({ streamId, startedAt }));
        expect(first._tag).toBe("Failure");
        expect(Option.getOrThrow((yield* Ref.get(state)).transitionCheckpoint)).toMatchObject({
          spotifyTokenNotified: true,
          twitchTokenNotified: true,
          lifecycleEventPublished: false,
          viewerPollingUpdated: false,
        });

        yield* stream.markOnline({ streamId, startedAt });
      }).pipe(Effect.provide(layer));

      expect(yield* Ref.get(tokenCalls)).toEqual(["online:spotify", "online:twitch"]);
      const ids = yield* Ref.get(publishedIds);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(ids[0]);
      expect(yield* Ref.get(alarmCalls)).toBe(1);
      expect(Option.isNone((yield* Ref.get(state)).transitionCheckpoint)).toBe(true);
    }),
  );

  it.effect("serializes concurrent lifecycle mutations before checkpoint reads", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialStreamState());
      const readCount = yield* Ref.make(0);
      const firstReadEntered = yield* Deferred.make<void>();
      const releaseFirstRead = yield* Deferred.make<void>();
      const concurrentReadEntered = yield* Deferred.make<void>();
      const firstOfflineProviderEntered = yield* Deferred.make<void>();
      const offlineProviderCalls = yield* Ref.make(0);
      const blockOfflineProvider = yield* Ref.make(false);
      const snapshotReadTarget = yield* Ref.make<Option.Option<number>>(Option.none());
      const snapshotReadEntered = yield* Deferred.make<void>();
      const releaseSnapshotRead = yield* Deferred.make<void>();
      const recordedStateTags = yield* Ref.make<ReadonlyArray<string>>([]);

      const database: IStreamDatabase = {
        getState: () =>
          Effect.gen(function* () {
            const read = yield* Ref.getAndUpdate(readCount, (count) => count + 1);

            if (read === 0) {
              yield* Deferred.succeed(firstReadEntered, undefined);
              yield* Deferred.await(releaseFirstRead);
            } else {
              yield* Deferred.succeed(concurrentReadEntered, undefined);
            }

            const target = yield* Ref.get(snapshotReadTarget);

            if (Option.isSome(target) && target.value === read) {
              const snapshot = yield* Ref.get(state);
              yield* Deferred.succeed(snapshotReadEntered, undefined);
              yield* Deferred.await(releaseSnapshotRead);

              return snapshot;
            }

            return yield* Ref.get(state);
          }),
        saveState: (next) => Ref.set(state, next),
        recordViewerCount: (input) =>
          Ref.update(recordedStateTags, (tags) => [...tags, input.state._tag]).pipe(
            Effect.as(input.state),
          ),
        getViewerHistory: () => Effect.succeed({ snapshots: [], totalCount: 0 }),
        getViewerSnapshotCount: () => Effect.succeed(0),
        reset: () => Ref.set(state, initialStreamState()).pipe(Effect.as(initialStreamState())),
      };

      const layer = streamLifecycleLayerWithoutDependencies.pipe(
        Layer.provide(Layer.succeed(StreamDatabase, StreamDatabase.of(database))),
        Layer.provide(
          Layer.succeed(
            ProviderAccessTokens,
            ProviderAccessTokens.of({
              getValidAccessToken: () => Effect.die("not used"),
              setTokens: () => Effect.die("not used"),
              onStreamOnline: () => Effect.void,
              onStreamOffline: (provider) =>
                Effect.gen(function* () {
                  if (provider !== "spotify" || !(yield* Ref.get(blockOfflineProvider))) return;
                  const call = yield* Ref.getAndUpdate(offlineProviderCalls, (count) => count + 1);

                  if (call === 0) {
                    yield* Deferred.succeed(firstOfflineProviderEntered, undefined);
                    yield* Effect.never;
                  }
                }),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(EventPublisher, EventPublisher.of({ publish: () => Effect.void })),
        ),
        Layer.provide(streamAlarmTestLayer),
        Layer.provide(streamViewerProviderTestLayer),
        Layer.provide(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const stream = yield* StreamLifecycle;
        const first = yield* Effect.forkChild(stream.markOnline({ streamId, startedAt }));
        yield* Deferred.await(firstReadEntered);
        const second = yield* Effect.forkChild(stream.markOnline({ streamId, startedAt }));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(concurrentReadEntered)).toBe(false);
        yield* Deferred.succeed(releaseFirstRead, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Ref.get(readCount)).toBeGreaterThan(1);

        const nextRead = yield* Ref.get(readCount);
        yield* Ref.set(snapshotReadTarget, Option.some(nextRead + 1));

        const reconciliation = yield* Effect.forkChild(
          stream.reconcile({
            stream: Option.some({
              id: streamId,
              startedAt,
              viewerCount: Schema.decodeUnknownSync(NonNegativeInt)(5),
            }),
            observedAt: Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T12:00:00.000Z"),
          }),
        );

        yield* Deferred.await(snapshotReadEntered);

        const offline = yield* Effect.forkChild(
          stream.markOffline({
            endedAt: Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T12:05:00.000Z"),
          }),
        );

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        expect((yield* Ref.get(state))._tag).toBe("LiveStream");
        yield* Deferred.succeed(releaseSnapshotRead, undefined);
        expect((yield* Fiber.join(reconciliation)).action).toBe("recorded_viewer_count");
        yield* Fiber.join(offline);
        expect(yield* Ref.get(recordedStateTags)).toEqual(["LiveStream"]);

        const restartedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T12:30:00.000Z");
        yield* stream.markOnline({ streamId, startedAt: restartedAt });
        const endedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:00:00.000Z");

        yield* Ref.set(blockOfflineProvider, true);
        const interrupted = yield* Effect.forkChild(stream.markOffline({ endedAt }));
        yield* Deferred.await(firstOfflineProviderEntered);
        yield* Fiber.interrupt(interrupted);
        yield* stream.markOffline({ endedAt });

        expect(yield* Ref.get(offlineProviderCalls)).toBe(2);
        expect((yield* stream.getState()).isLive).toBe(false);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "client over the in-memory lifecycle completes an online transition and records viewer peaks",
    () =>
      Effect.gen(function* () {
        const tokenCalls = yield* Ref.make<ReadonlyArray<string>>([]);
        const published = yield* Ref.make<ReadonlyArray<string>>([]);

        const controlledLayer = Layer.effect(
          StreamLifecycleClient,
          Effect.gen(function* () {
            return StreamLifecycleClient.of(yield* StreamLifecycle);
          }),
        ).pipe(
          Layer.provide(streamLifecycleLayerWithoutDependencies),
          Layer.provide([
            streamDatabaseTestLayer,
            streamAlarmTestLayer,
            streamViewerProviderTestLayer,
          ]),
          Layer.provide(
            Layer.succeed(
              ProviderAccessTokens,
              ProviderAccessTokens.of({
                getValidAccessToken: () => Effect.die("not used"),
                setTokens: () => Effect.die("not used"),
                onStreamOnline: (provider) =>
                  Ref.update(tokenCalls, (calls) => [...calls, `online:${provider}`]),
                onStreamOffline: (provider) =>
                  Ref.update(tokenCalls, (calls) => [...calls, `offline:${provider}`]),
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              EventPublisher,
              EventPublisher.of({
                publish: (event) => Ref.update(published, (types) => [...types, event.type]),
              }),
            ),
          ),
          Layer.provide(NodeCrypto.layer),
        );

        yield* Effect.gen(function* () {
          const stream = yield* StreamLifecycleClient;
          yield* stream.markOnline({ streamId, startedAt });

          const recordedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T12:00:00.000Z");
          yield* stream.recordViewerCount({ count: NonNegativeInt.make(7), recordedAt });

          expect(yield* stream.getStatus()).toMatchObject({
            healthy: true,
            effectsPending: false,
            state: { isLive: true, peakViewerCount: 7 },
          });
          expect(
            (yield* stream.getViewerHistory({
              since: Option.none(),
              until: Option.none(),
              limit: 10,
              offset: 0,
            })).snapshots,
          ).toEqual([{ timestamp: recordedAt, viewerCount: 7 }]);
        }).pipe(Effect.provide(controlledLayer));

        expect(yield* Ref.get(tokenCalls)).toEqual(["online:spotify", "online:twitch"]);
        expect(yield* Ref.get(published)).toEqual(["stream_online"]);
      }),
  );

  it.effect(
    "ends a superseded session, starts the restarted stream, and ignores the late offline notification",
    () =>
      Effect.gen(function* () {
        const published = yield* Ref.make<ReadonlyArray<string>>([]);
        const tokenCalls = yield* Ref.make<ReadonlyArray<string>>([]);
        const liveStream = yield* Ref.make<Option.Option<TwitchStreamInfo>>(Option.none());

        const restartedId = Schema.decodeUnknownSync(StreamId)("stream-456");
        const restartedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:07:21Z");

        const layer = streamLifecycleLayerWithoutDependencies.pipe(
          Layer.provide([streamDatabaseTestLayer, streamAlarmTestLayer]),
          Layer.provide(
            Layer.succeed(
              StreamViewerProvider,
              StreamViewerProvider.of({ getLiveStream: () => Ref.get(liveStream) }),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              ProviderAccessTokens,
              ProviderAccessTokens.of({
                getValidAccessToken: () => Effect.die("not used"),
                setTokens: () => Effect.die("not used"),
                onStreamOnline: (provider) =>
                  Ref.update(tokenCalls, (calls) => [...calls, `online:${provider}`]),
                onStreamOffline: (provider) =>
                  Ref.update(tokenCalls, (calls) => [...calls, `offline:${provider}`]),
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(
              EventPublisher,
              EventPublisher.of({
                publish: (event) =>
                  Ref.update(published, (events) => [...events, describeLifecycleEvent(event)]),
              }),
            ),
          ),
          Layer.provide(NodeCrypto.layer),
        );

        yield* Effect.gen(function* () {
          const stream = yield* StreamLifecycle;
          yield* stream.markOnline({ streamId, startedAt });
          yield* stream.markOnline({ streamId: restartedId, startedAt: restartedAt });

          expect(yield* stream.getState()).toMatchObject({
            isLive: true,
            startedAt: Option.some(restartedAt),
          });

          yield* stream.markOffline({
            endedAt: Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:07:37.83537036Z"),
          });

          expect(yield* stream.getState()).toMatchObject({
            isLive: true,
            startedAt: Option.some(restartedAt),
          });

          yield* stream.markOnline({ streamId: restartedId, startedAt: restartedAt });

          const endedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T15:00:00Z");
          yield* stream.markOffline({ endedAt });

          expect(yield* stream.getState()).toMatchObject({
            isLive: false,
            startedAt: Option.some(restartedAt),
            endedAt: Option.some(endedAt),
          });
        }).pipe(Effect.provide(layer));

        expect(yield* Ref.get(published)).toEqual([
          `stream_online:${streamId}:${startedAt}`,
          `stream_offline:${streamId}:${restartedAt}`,
          `stream_online:${restartedId}:${restartedAt}`,
          `stream_offline:${restartedId}:2026-01-30T15:00:00Z`,
        ]);
        expect(yield* Ref.get(tokenCalls)).toEqual([
          "online:spotify",
          "online:twitch",
          "offline:spotify",
          "offline:twitch",
          "online:spotify",
          "online:twitch",
          "offline:spotify",
          "offline:twitch",
        ]);
      }),
  );

  it.effect("viewer polling replaces a live session when Twitch reports a newer stream", () =>
    Effect.gen(function* () {
      const restarted: TwitchStreamInfo = {
        id: Schema.decodeUnknownSync(StreamId)("stream-456"),
        startedAt: Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:07:21Z"),
        viewerCount: NonNegativeInt.make(120),
        gameName: "Software and Game Development",
        title: "restarted",
      };

      const layer = streamLifecycleLayerWithoutDependencies.pipe(
        Layer.provide([streamDatabaseTestLayer, streamAlarmTestLayer]),
        Layer.provide(
          Layer.succeed(
            StreamViewerProvider,
            StreamViewerProvider.of({
              getLiveStream: () => Effect.succeed(Option.some(restarted)),
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            ProviderAccessTokens,
            ProviderAccessTokens.of({
              getValidAccessToken: () => Effect.die("not used"),
              setTokens: () => Effect.die("not used"),
              onStreamOnline: () => Effect.void,
              onStreamOffline: () => Effect.void,
            }),
          ),
        ),
        Layer.provide(
          Layer.succeed(EventPublisher, EventPublisher.of({ publish: () => Effect.void })),
        ),
        Layer.provide(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const stream = yield* StreamLifecycle;
        yield* stream.markOnline({ streamId, startedAt });
        yield* stream.processAlarm();

        expect(yield* stream.getState()).toMatchObject({
          isLive: true,
          startedAt: Option.some(restarted.startedAt),
          peakViewerCount: 120,
        });
        expect((yield* stream.getDebugState()).activeStreamId).toEqual(Option.some(restarted.id));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "recovers a restarted stream from Twitch when the offline notification won the race",
    () =>
      Effect.gen(function* () {
        const restartedId = Schema.decodeUnknownSync(StreamId)("stream-456");
        const restartedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:07:21Z");

        const layer = streamLifecycleLayerWithoutDependencies.pipe(
          Layer.provide([
            streamDatabaseTestLayer,
            streamAlarmTestLayer,
            streamViewerProviderTestLayer,
          ]),
          Layer.provide(
            Layer.succeed(
              ProviderAccessTokens,
              ProviderAccessTokens.of({
                getValidAccessToken: () => Effect.die("not used"),
                setTokens: () => Effect.die("not used"),
                onStreamOnline: () => Effect.void,
                onStreamOffline: () => Effect.void,
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(EventPublisher, EventPublisher.of({ publish: () => Effect.void })),
          ),
          Layer.provide(NodeCrypto.layer),
        );

        yield* Effect.gen(function* () {
          const stream = yield* StreamLifecycle;
          yield* stream.markOnline({ streamId, startedAt });
          yield* stream.markOffline({
            endedAt: Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:07:37.83537036Z"),
          });

          const observedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T13:50:00Z");

          const restarted = yield* stream.reconcile({
            stream: Option.some({
              id: restartedId,
              startedAt: restartedAt,
              viewerCount: NonNegativeInt.make(120),
            }),
            observedAt,
          });

          expect(restarted).toMatchObject({
            action: "marked_online",
            after: { isLive: true, startedAt: Option.some(restartedAt) },
          });

          const stale = yield* stream.reconcile({
            stream: Option.some({ id: streamId, startedAt, viewerCount: NonNegativeInt.make(1) }),
            observedAt,
          });

          expect(stale).toMatchObject({
            action: "noop",
            after: { isLive: true, startedAt: Option.some(restartedAt) },
          });
        }).pipe(Effect.provide(layer));
      }),
  );
});
