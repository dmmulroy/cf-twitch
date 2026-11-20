import { Clock, Context, Effect, Layer, Option, Predicate, Schema, Semaphore } from "effect";
import { Digest } from "effect/crypto";
import { type DomainEvent } from "@cf-twitch/contracts/domain-event";
import { IsoTimestamp } from "@cf-twitch/contracts/identity";
import {
  StreamLifecycleError,
  type MarkStreamOfflineInput,
  type MarkStreamOnlineInput,
  type RecordViewerCountInput,
  type StreamProviderState,
  type StreamReconciliationAction,
  type StreamTransitionCheckpoint,
} from "@cf-twitch/contracts/stream";
import { ProviderAccessTokens } from "../providers/provider-access-tokens.ts";
import { EventPublisher } from "../events/event-bus-service.ts";
import { StreamAlarm, streamAlarmLayer, streamAlarmTestLayer } from "./stream-alarm.ts";
import { StreamDatabase, streamDatabaseLayer, streamDatabaseTestLayer } from "./stream-database.ts";
import type { IStreamLifecycleClient } from "./stream-lifecycle-client.ts";
import {
  acceptOfflineTransition,
  acceptOnlineTransition,
  clearCompletedTransition,
  completeTransitionEffect,
  deriveStreamLifecycleEventId,
  toStreamLifecycleState,
  type PersistedStreamState,
  type StreamTransitionEffect,
} from "./stream-state.ts";
import { StreamViewerProvider, streamViewerProviderTestLayer } from "./stream-viewer-provider.ts";

const VIEWER_POLL_INTERVAL_MS = 60_000;

/**
 * Stream Lifecycle operations plus the Durable Object hooks that recover effects and poll viewers.
 *
 * **Details**
 *
 * `resumeTransitionEffects`, `rebuildAlarm`, and `processAlarm` are private to the
 * `StreamLifecycleDO` runtime; they are not exposed as remote HTTP operations. Every operation
 * runs under one mutation lock.
 */
export interface IStreamLifecycle extends IStreamLifecycleClient {
  /**
   * Resumes incomplete effects of the saved transition checkpoint, in order.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` whose reason is `effects_pending` when a
   *   token notification or event publication fails, or a persistence reason when storage or the
   *   alarm fails; completed effects stay recorded.
   */
  readonly resumeTransitionEffects: () => Effect.Effect<void, StreamLifecycleError>;
  /**
   * Reinstalls the platform alarm from durable state after a restart.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` when storage or the alarm fails, or the
   *   saved poll instant is invalid.
   */
  readonly rebuildAlarm: () => Effect.Effect<void, StreamLifecycleError>;
  /**
   * Runs alarm work: resumes transition effects, then records a viewer count while live.
   *
   * @returns Nothing, or fails with `StreamLifecycleError` when effects remain pending, Twitch
   *   cannot be read, or storage or the alarm fails.
   */
  readonly processAlarm: () => Effect.Effect<void, StreamLifecycleError>;
}

/** Service for the in-Durable-Object Stream Lifecycle authority behind `StreamLifecycleClient`. */
export class StreamLifecycle extends Context.Service<StreamLifecycle, IStreamLifecycle>()(
  "@cf-twitch/StreamLifecycle",
) {}

const decodeComputedIsoTimestamp = Schema.decodeEffect(IsoTimestamp);

/** Returns the instant `epochMillis` as a timestamp; `Date#toISOString` output always parses. */
const timestampAt = (epochMillis: number) =>
  decodeComputedIsoTimestamp(new Date(epochMillis).toISOString()).pipe(Effect.orDie);

/** Returns the instant `delay` milliseconds from now. */
const nextAlarmTimestamp = (delay: number) =>
  Clock.currentTimeMillis.pipe(Effect.flatMap((now) => timestampAt(now + delay)));

/** Returns the domain event published for an accepted transition checkpoint. */
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

/** Returns the failure for a transition effect that could not complete and remains pending. */
const effectsPending = (checkpoint: StreamTransitionCheckpoint) =>
  new StreamLifecycleError({
    operation: "resumeTransitionEffects",
    reason: "effects_pending",
    streamId: Option.some(checkpoint.streamId),
  });

/**
 * Creates the Stream Lifecycle authority: source-time transitions, durable effect recovery, and
 * viewer polling.
 *
 * **Details**
 *
 * A transition and its four incomplete effects are saved before any effect runs. Effects then run
 * in order (Spotify token, Twitch token, event publication, viewer polling), each recorded on
 * completion, so a retry resumes rather than repeats them.
 *
 * @returns The Stream Lifecycle service; its operations fail as documented on `IStreamLifecycle`.
 * @throws {PlatformError} As a defect when the SHA-256 digest primitive is unavailable.
 */
export const makeStreamLifecycle = Effect.gen(function* () {
  const database = yield* StreamDatabase;
  const accessTokens = yield* ProviderAccessTokens;
  const events = yield* EventPublisher;
  const alarm = yield* StreamAlarm;
  const viewerProvider = yield* StreamViewerProvider;
  const digestService = yield* Digest.Digest;
  const withMutationPermit = Semaphore.withPermit(yield* Semaphore.make(1));

  const saveEffectCheckpoint = Effect.fn("StreamLifecycle.saveEffectCheckpoint")(function* (
    state: PersistedStreamState,
    checkpoint: StreamTransitionCheckpoint,
    effect: StreamTransitionEffect,
  ) {
    const updated = completeTransitionEffect(state, checkpoint.eventId, effect);
    yield* database.saveState(updated);

    return updated;
  });

  const resumeProviderTokenNotification = Effect.fn(
    "StreamLifecycle.resumeProviderTokenNotification",
  )(function* (
    state: PersistedStreamState,
    provider: "spotify" | "twitch",
    effect: "spotifyTokenNotified" | "twitchTokenNotified",
  ) {
    if (Option.isNone(state.transitionCheckpoint) || state.transitionCheckpoint.value[effect])
      return state;
    const checkpoint = state.transitionCheckpoint.value;
    yield* (
      checkpoint.transition === "online"
        ? accessTokens.onStreamOnline(provider)
        : accessTokens.onStreamOffline(provider)
    ).pipe(Effect.catchTag("ProviderError", () => Effect.fail(effectsPending(checkpoint))));

    return yield* saveEffectCheckpoint(state, checkpoint, effect);
  });

  const resumeLifecycleEventPublication = Effect.fn(
    "StreamLifecycle.resumeLifecycleEventPublication",
  )(function* (state: PersistedStreamState) {
    if (
      Option.isNone(state.transitionCheckpoint) ||
      state.transitionCheckpoint.value.lifecycleEventPublished
    )
      return state;
    const checkpoint = state.transitionCheckpoint.value;
    yield* events
      .publish(lifecycleEvent(checkpoint))
      .pipe(Effect.catchTag("EventBusError", () => Effect.fail(effectsPending(checkpoint))));

    return yield* saveEffectCheckpoint(state, checkpoint, "lifecycleEventPublished");
  });

  const resumeViewerPollingUpdate = Effect.fn("StreamLifecycle.resumeViewerPollingUpdate")(
    function* (state: PersistedStreamState) {
      if (
        Option.isNone(state.transitionCheckpoint) ||
        state.transitionCheckpoint.value.viewerPollingUpdated
      )
        return state;
      const checkpoint = state.transitionCheckpoint.value;

      if (checkpoint.transition === "offline") {
        yield* alarm.clear();

        return yield* saveEffectCheckpoint(state, checkpoint, "viewerPollingUpdated");
      }

      const dueAt = yield* nextAlarmTimestamp(VIEWER_POLL_INTERVAL_MS);
      yield* alarm.scheduleAt(dueAt);

      const withSchedule = Predicate.isTagged("LiveStream")(state)
        ? {
            ...state,
            viewerPollScheduleId: Option.some(dueAt),
            transitionCheckpoint: Option.some({
              ...checkpoint,
              viewerPollScheduleId: Option.some(dueAt),
            }),
          }
        : state;

      const updated = completeTransitionEffect(
        withSchedule,
        checkpoint.eventId,
        "viewerPollingUpdated",
      );

      yield* database.saveState(updated);

      return updated;
    },
  );

  const resumeTransitionEffectsWithoutPermit = Effect.fn(
    "StreamLifecycle.resumeTransitionEffectsWithoutPermit",
  )(function* () {
    const initial = yield* database.getState();

    if (Option.isNone(initial.transitionCheckpoint)) return;

    const spotifyNotified = yield* resumeProviderTokenNotification(
      initial,
      "spotify",
      "spotifyTokenNotified",
    );

    const twitchNotified = yield* resumeProviderTokenNotification(
      spotifyNotified,
      "twitch",
      "twitchTokenNotified",
    );

    const eventPublished = yield* resumeLifecycleEventPublication(twitchNotified);
    const pollingUpdated = yield* resumeViewerPollingUpdate(eventPublished);
    yield* database.saveState(clearCompletedTransition(pollingUpdated));
  });

  const getState = Effect.fn("StreamLifecycle.getState")(function* () {
    return toStreamLifecycleState(yield* database.getState());
  });

  const markOnlineWithoutPermit = Effect.fn("StreamLifecycle.markOnlineWithoutPermit")(function* (
    input: MarkStreamOnlineInput,
  ) {
    yield* resumeTransitionEffectsWithoutPermit();
    const current = yield* database.getState();

    const eventId = yield* deriveStreamLifecycleEventId({
      transition: "online",
      streamId: input.streamId,
      transitionAt: input.startedAt,
    }).pipe(Effect.provideService(Digest.Digest, digestService));

    const accepted = acceptOnlineTransition(current, { ...input, eventId });

    if (accepted !== current) yield* database.saveState(accepted);
    yield* resumeTransitionEffectsWithoutPermit();

    return toStreamLifecycleState(yield* database.getState());
  });

  const markOfflineWithoutPermit = Effect.fn("StreamLifecycle.markOfflineWithoutPermit")(function* (
    input: MarkStreamOfflineInput,
  ) {
    yield* resumeTransitionEffectsWithoutPermit();
    const current = yield* database.getState();

    const streamId = Predicate.isTagged("LiveStream")(current)
      ? Option.some(current.streamId)
      : Option.map(current.transitionCheckpoint, (checkpoint) => checkpoint.streamId);

    if (Option.isNone(streamId)) return toStreamLifecycleState(current);

    const eventId = yield* deriveStreamLifecycleEventId({
      transition: "offline",
      streamId: streamId.value,
      transitionAt: input.endedAt,
    }).pipe(Effect.provideService(Digest.Digest, digestService));

    const accepted = acceptOfflineTransition(current, { ...input, eventId });

    if (accepted !== current) yield* database.saveState(accepted);
    yield* resumeTransitionEffectsWithoutPermit();

    return toStreamLifecycleState(yield* database.getState());
  });

  const recordViewerCountWithoutPermit = Effect.fn(
    "StreamLifecycle.recordViewerCountWithoutPermit",
  )(function* (input: RecordViewerCountInput) {
    const state = yield* database.getState();
    yield* database.recordViewerCount({
      state,
      count: input.count,
      recordedAt: input.recordedAt,
    });
  });

  const reconcile = Effect.fn("StreamLifecycle.reconcile")(function* (input: StreamProviderState) {
    const before = yield* getState();
    let action: StreamReconciliationAction = "noop";

    if (Option.isSome(input.stream)) {
      const state = yield* database.getState();

      if (Predicate.isTagged("OfflineStream")(state)) {
        yield* markOnlineWithoutPermit({
          streamId: input.stream.value.id,
          startedAt: input.stream.value.startedAt,
        });
        action = "marked_online";
      } else {
        yield* recordViewerCountWithoutPermit({
          count: input.stream.value.viewerCount,
          recordedAt: input.observedAt,
        });
        action = "recorded_viewer_count";
      }
    } else {
      const state = yield* database.getState();

      if (Predicate.isTagged("LiveStream")(state)) {
        yield* markOfflineWithoutPermit({ endedAt: input.observedAt });
        action = "marked_offline";
      }
    }

    return { action, before, after: yield* getState() };
  }, withMutationPermit);

  const rebuildAlarm = Effect.fn("StreamLifecycle.rebuildAlarm")(function* () {
    const state = yield* database.getState();

    if (Option.isSome(state.transitionCheckpoint)) {
      yield* alarm.scheduleAt(yield* nextAlarmTimestamp(1_000));
    } else if (Predicate.isTagged("LiveStream")(state)) {
      const dueAt = yield* Option.match(state.viewerPollScheduleId, {
        onNone: () => nextAlarmTimestamp(VIEWER_POLL_INTERVAL_MS),
        onSome: (scheduled) =>
          decodeComputedIsoTimestamp(scheduled).pipe(
            Effect.catchTag("SchemaError", () =>
              Effect.fail(
                new StreamLifecycleError({
                  operation: "rebuildAlarm",
                  reason: "stored_state_invalid",
                  streamId: Option.some(state.streamId),
                }),
              ),
            ),
          ),
      });

      yield* alarm.scheduleAt(dueAt);
    } else {
      yield* alarm.clear();
    }
  }, withMutationPermit);

  const processAlarm = Effect.fn("StreamLifecycle.processAlarm")(function* () {
    yield* resumeTransitionEffectsWithoutPermit();
    let state = yield* database.getState();

    if (Predicate.isTagged("OfflineStream")(state)) {
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

    if (Predicate.isTagged("LiveStream")(state)) {
      yield* database.saveState({ ...state, viewerPollScheduleId: Option.some(dueAt) });
    }
  }, withMutationPermit);

  return StreamLifecycle.of({
    getState,
    markOnline: Effect.fn("StreamLifecycle.markOnline")(
      (input) => markOnlineWithoutPermit(input),
      withMutationPermit,
    ),
    markOffline: Effect.fn("StreamLifecycle.markOffline")(
      (input) => markOfflineWithoutPermit(input),
      withMutationPermit,
    ),
    recordViewerCount: Effect.fn("StreamLifecycle.recordViewerCount")(
      (input) => recordViewerCountWithoutPermit(input),
      withMutationPermit,
    ),
    getViewerHistory: Effect.fn("StreamLifecycle.getViewerHistory")(function* (input) {
      const history = yield* database.getViewerHistory(input);

      return { ...history, limit: input.limit, offset: input.offset };
    }),
    reconcile,
    getStatus: Effect.fn("StreamLifecycle.getStatus")(function* () {
      const state = yield* database.getState();

      return {
        healthy: true,
        effectsPending: Option.isSome(state.transitionCheckpoint),
        state: toStreamLifecycleState(state),
      };
    }),
    getDebugState: Effect.fn("StreamLifecycle.getDebugState")(function* () {
      const state = yield* database.getState();

      return {
        state: toStreamLifecycleState(state),
        activeStreamId: Predicate.isTagged("LiveStream")(state)
          ? Option.some(state.streamId)
          : Option.none(),
        transitionCheckpoint: state.transitionCheckpoint,
        viewerSnapshotCount: yield* database.getViewerSnapshotCount(),
      };
    }),
    reset: Effect.fn("StreamLifecycle.reset")(function* () {
      yield* database.reset();
      yield* alarm.clear();
    }, withMutationPermit),
    resumeTransitionEffects: Effect.fn("StreamLifecycle.resumeTransitionEffects")(
      () => resumeTransitionEffectsWithoutPermit(),
      withMutationPermit,
    ),
    rebuildAlarm,
    processAlarm,
  });
});

/** Layer that provides Stream Lifecycle, leaving storage, alarm, viewer, token, and event services visible. */
export const streamLifecycleLayerWithoutDependencies = Layer.effect(
  StreamLifecycle,
  makeStreamLifecycle,
);

/**
 * Layer that provides Stream Lifecycle over SQLite storage and the platform alarm.
 *
 * **Details**
 *
 * The Durable Object's SQL client and state, plus the viewer provider, token, event, and digest
 * services captured during outer initialization, stay visible for the `StreamLifecycleDO` runtime.
 */
export const streamLifecycleLayer = streamLifecycleLayerWithoutDependencies.pipe(
  Layer.provide([streamDatabaseLayer, streamAlarmLayer]),
);

/**
 * Layer that provides Stream Lifecycle over in-memory storage, a non-firing alarm, and an offline
 * viewer provider.
 *
 * **Details**
 *
 * Provider tokens, event publication, and the digest stay visible so each test selects controlled
 * implementations.
 */
export const streamLifecycleTestLayer = streamLifecycleLayerWithoutDependencies.pipe(
  Layer.provide([streamDatabaseTestLayer, streamAlarmTestLayer, streamViewerProviderTestLayer]),
);
