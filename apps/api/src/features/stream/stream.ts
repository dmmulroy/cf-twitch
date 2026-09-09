import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { type DomainEvent } from "@cf-twitch/contracts/domain-event";
import { EventId, IsoTimestamp, NonNegativeInt, StreamId } from "@cf-twitch/contracts/identity";
import { StreamLifecycleError, type StreamTransitionCheckpoint } from "@cf-twitch/contracts/stream";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { EventPublisher } from "../events/event-bus-service.ts";
import { StreamDatabase } from "./stream-database.ts";
import { StreamLifecycleClient, type IStreamLifecycleClient } from "./stream-lifecycle.ts";
import {
  acceptOfflineTransition,
  acceptOnlineTransition,
  clearCompletedTransition,
  completeTransitionEffect,
  toStreamLifecycleState,
  type PersistedStreamState,
} from "./stream-state.ts";

const VIEWER_POLL_INTERVAL_MS = 60_000;

/** Native alarm boundary for viewer polling and incomplete transition recovery. */
export interface IStreamAlarm {
  readonly scheduleAt: (timestamp: IsoTimestamp) => Effect.Effect<void, StreamLifecycleError>;
  readonly clear: () => Effect.Effect<void, StreamLifecycleError>;
}

/** Stream Lifecycle Durable Object alarm capability. */
export class StreamAlarm extends Context.Service<StreamAlarm, IStreamAlarm>()(
  "@cf-twitch/StreamAlarm",
) {}

/** Provider viewer lookup used only by the physical Stream Lifecycle server alarm. */
export interface IStreamViewerProvider {
  readonly getViewerCount: () => Effect.Effect<Option.Option<NonNegativeInt>, StreamLifecycleError>;
}

/** Provider-backed viewer observation capability. */
export class StreamViewerProvider extends Context.Service<
  StreamViewerProvider,
  IStreamViewerProvider
>()("@cf-twitch/StreamViewerProvider") {}

/** Alarm processing and transition recovery operations. */
export interface IStreamProcessor {
  readonly resumeTransitionEffects: () => Effect.Effect<void, StreamLifecycleError>;
  readonly rebuildAlarm: () => Effect.Effect<void, StreamLifecycleError>;
  readonly processAlarm: () => Effect.Effect<void, StreamLifecycleError>;
}

/** Stream Lifecycle background processor. */
export class StreamProcessor extends Context.Service<StreamProcessor, IStreamProcessor>()(
  "@cf-twitch/StreamProcessor",
) {}

const streamError = (
  operation: StreamLifecycleError["operation"],
  reason: StreamLifecycleError["reason"],
) => new StreamLifecycleError({ operation, reason });

const parseComputedTimestamp = Schema.decodeEffect(IsoTimestamp);

const timestampAt = (epochMillis: number) =>
  parseComputedTimestamp(new Date(epochMillis).toISOString()).pipe(Effect.orDie);

const nextAlarmTimestamp = (delay: number) =>
  Clock.currentTimeMillis.pipe(Effect.flatMap((now) => timestampAt(now + delay)));

/** Deterministically derive a UUID from accepted transition evidence for stable replay identity. */
export const deriveLifecycleEventId = (input: {
  readonly transition: "online" | "offline";
  readonly streamId: StreamId;
  readonly transitionAt: IsoTimestamp;
}): Effect.Effect<EventId> =>
  Effect.promise(async () => {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `cf-twitch:stream-lifecycle:${input.transition}:${input.streamId}:${input.transitionAt}`,
      ),
    );

    const value = Array.from(new Uint8Array(bytes).slice(0, 16));
    value[6] = ((value[6] ?? 0) & 0x0f) | 0x50;
    value[8] = ((value[8] ?? 0) & 0x3f) | 0x80;
    const hex = value.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

    return EventId.make(uuid);
  });

const lifecycleEvent = (checkpoint: StreamTransitionCheckpoint): DomainEvent =>
  checkpoint.transition === "online"
    ? {
        id: checkpoint.eventId,
        v: 1,
        timestamp: checkpoint.transitionAt,
        correlationId: Option.none(),
        type: "stream_online",
        source: "StreamLifecycleDO",
        streamId: checkpoint.streamId,
        startedAt: checkpoint.transitionAt,
      }
    : {
        id: checkpoint.eventId,
        v: 1,
        timestamp: checkpoint.transitionAt,
        correlationId: Option.none(),
        type: "stream_offline",
        source: "StreamLifecycleDO",
        streamId: checkpoint.streamId,
        endedAt: checkpoint.transitionAt,
      };

/** Construct local Stream Lifecycle state transitions and durable side-effect recovery. */
export const makeStreamLifecycle = Effect.gen(function* () {
  const database = yield* StreamDatabase;
  const accessTokens = yield* ProviderAccessTokens;
  const events = yield* EventPublisher;
  const alarm = yield* StreamAlarm;
  const viewerProvider = yield* StreamViewerProvider;

  const saveEffectCheckpoint = Effect.fn("StreamLifecycle.saveEffectCheckpoint")(function* (
    state: PersistedStreamState,
    checkpoint: StreamTransitionCheckpoint,
    effect: Parameters<typeof completeTransitionEffect>[2],
  ) {
    const updated = completeTransitionEffect(state, checkpoint.eventId, effect);
    yield* database.saveState(updated);

    return updated;
  });

  const resumeTransitionEffects = Effect.fn("StreamLifecycle.resumeTransitionEffects")(
    function* () {
      let state = yield* database.getState();
      const initialCheckpoint = state.transitionCheckpoint;

      if (initialCheckpoint === null) return;

      if (!initialCheckpoint.spotifyTokenNotified) {
        yield* (
          initialCheckpoint.transition === "online"
            ? accessTokens.onStreamOnline("spotify")
            : accessTokens.onStreamOffline("spotify")
        ).pipe(Effect.mapError(() => streamError("resumeTransitionEffects", "effects_pending")));
        state = yield* saveEffectCheckpoint(state, initialCheckpoint, "spotifyTokenNotified");
      }

      const twitchCheckpoint = state.transitionCheckpoint;

      if (twitchCheckpoint !== null && !twitchCheckpoint.twitchTokenNotified) {
        yield* (
          twitchCheckpoint.transition === "online"
            ? accessTokens.onStreamOnline("twitch")
            : accessTokens.onStreamOffline("twitch")
        ).pipe(Effect.mapError(() => streamError("resumeTransitionEffects", "effects_pending")));
        state = yield* saveEffectCheckpoint(state, twitchCheckpoint, "twitchTokenNotified");
      }

      const eventCheckpoint = state.transitionCheckpoint;

      if (eventCheckpoint !== null && !eventCheckpoint.lifecycleEventPublished) {
        yield* events
          .publish(lifecycleEvent(eventCheckpoint))
          .pipe(Effect.mapError(() => streamError("resumeTransitionEffects", "effects_pending")));
        state = yield* saveEffectCheckpoint(state, eventCheckpoint, "lifecycleEventPublished");
      }

      const pollingCheckpoint = state.transitionCheckpoint;

      if (pollingCheckpoint !== null && !pollingCheckpoint.viewerPollingUpdated) {
        if (pollingCheckpoint.transition === "online") {
          const dueAt = yield* nextAlarmTimestamp(VIEWER_POLL_INTERVAL_MS);
          yield* alarm.scheduleAt(dueAt);

          const withSchedule =
            state._tag === "LiveStream"
              ? {
                  ...state,
                  viewerPollScheduleId: dueAt,
                  transitionCheckpoint: { ...pollingCheckpoint, viewerPollScheduleId: dueAt },
                }
              : state;

          state = completeTransitionEffect(
            withSchedule,
            pollingCheckpoint.eventId,
            "viewerPollingUpdated",
          );
          yield* database.saveState(state);
        } else {
          yield* alarm.clear();
          state = yield* saveEffectCheckpoint(state, pollingCheckpoint, "viewerPollingUpdated");
        }
      }

      yield* database.saveState(clearCompletedTransition(state));
    },
  );

  const getState: IStreamLifecycleClient["getState"] = Effect.fn("StreamLifecycle.getState")(
    function* () {
      return toStreamLifecycleState(yield* database.getState());
    },
  );

  const markOnline: IStreamLifecycleClient["markOnline"] = Effect.fn("StreamLifecycle.markOnline")(
    function* (input) {
      yield* resumeTransitionEffects();
      const current = yield* database.getState();

      const eventId = yield* deriveLifecycleEventId({
        transition: "online",
        streamId: input.streamId,
        transitionAt: input.startedAt,
      });

      const accepted = acceptOnlineTransition(current, { ...input, eventId });

      if (accepted !== current) yield* database.saveState(accepted);
      yield* resumeTransitionEffects();

      return toStreamLifecycleState(yield* database.getState());
    },
  );

  const markOffline: IStreamLifecycleClient["markOffline"] = Effect.fn(
    "StreamLifecycle.markOffline",
  )(function* (input) {
    yield* resumeTransitionEffects();
    const current = yield* database.getState();

    const streamId =
      current._tag === "LiveStream" ? current.streamId : current.transitionCheckpoint?.streamId;

    if (streamId === undefined) return toStreamLifecycleState(current);

    const eventId = yield* deriveLifecycleEventId({
      transition: "offline",
      streamId,
      transitionAt: input.endedAt,
    });

    const accepted = acceptOfflineTransition(current, { ...input, eventId });

    if (accepted !== current) yield* database.saveState(accepted);
    yield* resumeTransitionEffects();

    return toStreamLifecycleState(yield* database.getState());
  });

  const recordViewerCount: IStreamLifecycleClient["recordViewerCount"] = Effect.fn(
    "StreamLifecycle.recordViewerCount",
  )(function* (input) {
    const state = yield* database.getState();
    yield* database.recordViewerCount({
      state,
      count: input.count,
      recordedAt: input.recordedAt,
    });
  });

  const reconcile: IStreamLifecycleClient["reconcile"] = Effect.fn("StreamLifecycle.reconcile")(
    function* (input) {
      const before = yield* getState();
      let action: "noop" | "marked_online" | "marked_offline" | "recorded_viewer_count" = "noop";

      if (Option.isSome(input.stream)) {
        const state = yield* database.getState();

        if (state._tag === "OfflineStream") {
          yield* markOnline({
            streamId: input.stream.value.id,
            startedAt: input.stream.value.startedAt,
          });
          action = "marked_online";
        } else {
          yield* recordViewerCount({
            count: input.stream.value.viewerCount,
            recordedAt: input.observedAt,
          });
          action = "recorded_viewer_count";
        }
      } else {
        const state = yield* database.getState();

        if (state._tag === "LiveStream") {
          yield* markOffline({ endedAt: input.observedAt });
          action = "marked_offline";
        }
      }

      return { action, before, after: yield* getState() };
    },
  );

  const client = StreamLifecycleClient.of({
    getState,
    markOnline,
    markOffline,
    recordViewerCount,
    getViewerHistory: Effect.fn("StreamLifecycle.getViewerHistory")(function* (input) {
      const history = yield* database.getViewerHistory(input);

      return { ...history, limit: input.limit, offset: input.offset };
    }),
    reconcile,
    getStatus: Effect.fn("StreamLifecycle.getStatus")(function* () {
      const state = yield* database.getState();

      return {
        healthy: true,
        effectsPending: state.transitionCheckpoint !== null,
        state: toStreamLifecycleState(state),
      };
    }),
    getDebugState: Effect.fn("StreamLifecycle.getDebugState")(function* () {
      const state = yield* database.getState();

      return {
        state: toStreamLifecycleState(state),
        activeStreamId: state._tag === "LiveStream" ? Option.some(state.streamId) : Option.none(),
        transitionCheckpoint: Option.fromNullOr(state.transitionCheckpoint),
        viewerSnapshotCount: yield* database.getViewerSnapshotCount(),
      };
    }),
    reset: Effect.fn("StreamLifecycle.reset")(function* () {
      yield* database.reset();
      yield* alarm.clear();
    }),
  });

  const rebuildAlarm = Effect.fn("StreamLifecycle.rebuildAlarm")(function* () {
    const state = yield* database.getState();

    if (state.transitionCheckpoint !== null) {
      yield* alarm.scheduleAt(yield* nextAlarmTimestamp(1_000));
    } else if (state._tag === "LiveStream") {
      const dueAt =
        state.viewerPollScheduleId === null
          ? yield* nextAlarmTimestamp(VIEWER_POLL_INTERVAL_MS)
          : yield* Schema.decodeEffect(IsoTimestamp)(state.viewerPollScheduleId).pipe(
              Effect.mapError(() => streamError("resumeTransitionEffects", "stored_state_invalid")),
            );

      yield* alarm.scheduleAt(dueAt);
    } else {
      yield* alarm.clear();
    }
  });

  const processAlarm = Effect.fn("StreamLifecycle.processAlarm")(function* () {
    yield* resumeTransitionEffects();
    let state = yield* database.getState();

    if (state._tag === "OfflineStream") {
      yield* alarm.clear();

      return;
    }

    const count = yield* viewerProvider.getViewerCount();

    if (Option.isSome(count)) {
      const recordedAt = yield* nextAlarmTimestamp(0);
      state = yield* database.recordViewerCount({ state, count: count.value, recordedAt });
    }

    const dueAt = yield* nextAlarmTimestamp(VIEWER_POLL_INTERVAL_MS);
    yield* alarm.scheduleAt(dueAt);

    if (state._tag === "LiveStream") {
      yield* database.saveState({ ...state, viewerPollScheduleId: dueAt });
    }
  });

  return {
    client,
    processor: StreamProcessor.of({ resumeTransitionEffects, rebuildAlarm, processAlarm }),
  };
});

/** Stream Lifecycle services acquired once with outgoing dependencies kept visible. */
export const streamLifecycleLayerWithoutDependencies = Layer.effectContext(
  Effect.gen(function* () {
    const services = yield* makeStreamLifecycle;

    return Context.make(StreamLifecycleClient, services.client).pipe(
      Context.add(StreamProcessor, services.processor),
    );
  }),
);
