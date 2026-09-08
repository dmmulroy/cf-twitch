import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import { EventId, IsoTimestamp, StreamId } from "@cf-twitch/contracts/identity";
import { EventPublisher } from "../events/event-bus-service.ts";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { StreamDatabase, type IStreamDatabase } from "./stream-database.ts";
import { StreamLifecycleClient } from "./stream-lifecycle.ts";
import {
  StreamAlarm,
  StreamViewerProvider,
  streamLifecycleLayerWithoutDependencies,
} from "./stream.ts";
import { initialStreamState } from "./stream-state.ts";

const startedAt = Schema.decodeUnknownSync(IsoTimestamp)("2026-01-30T11:55:00.000Z");
const streamId = Schema.decodeUnknownSync(StreamId)("stream-123");

describe("Stream Lifecycle", () => {
  it("resumes the same transition event from partial durable checkpoints", async () => {
    const program = Effect.gen(function* () {
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
        Layer.provide(
          Layer.succeed(
            StreamViewerProvider,
            StreamViewerProvider.of({ getViewerCount: () => Effect.succeed(Option.none()) }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const stream = yield* StreamLifecycleClient;
        const first = yield* Effect.result(stream.markOnline({ streamId, startedAt }));
        expect(first._tag).toBe("Failure");
        expect((yield* Ref.get(state)).transitionCheckpoint).toMatchObject({
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
      expect((yield* Ref.get(state)).transitionCheckpoint).toBeNull();
    });

    await Effect.runPromise(program);
  });
});
