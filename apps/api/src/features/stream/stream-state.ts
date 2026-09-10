import { DateTime, Effect, Option, Order, Schema } from "effect";
import { EventId, IsoTimestamp, NonNegativeInt, StreamId } from "@cf-twitch/contracts/identity";
import {
  StreamLifecycleError,
  type StreamLifecycleState,
  type StreamTransitionCheckpoint,
} from "@cf-twitch/contracts/stream";

const StreamTransitionCheckpointRecord = Schema.Struct({
  eventId: EventId,
  streamId: StreamId,
  transition: Schema.Literals(["online", "offline"]),
  transitionAt: IsoTimestamp,
  viewerPollScheduleId: Schema.NullOr(Schema.NonEmptyString),
  spotifyTokenNotified: Schema.Boolean,
  twitchTokenNotified: Schema.Boolean,
  lifecycleEventPublished: Schema.Boolean,
  viewerPollingUpdated: Schema.Boolean,
});

/** Persisted state while no Stream Session is active. */
export const OfflineStreamState = Schema.Struct({
  _tag: Schema.Literal("OfflineStream"),
  lastStartedAt: Schema.NullOr(IsoTimestamp),
  endedAt: Schema.NullOr(IsoTimestamp),
  peakViewerCount: NonNegativeInt,
  transitionCheckpoint: Schema.NullOr(StreamTransitionCheckpointRecord),
});

/** Persisted state while one Stream Session is active. */
export const LiveStreamState = Schema.Struct({
  _tag: Schema.Literal("LiveStream"),
  streamId: StreamId,
  startedAt: IsoTimestamp,
  peakViewerCount: NonNegativeInt,
  viewerPollScheduleId: Schema.NullOr(Schema.NonEmptyString),
  transitionCheckpoint: Schema.NullOr(StreamTransitionCheckpointRecord),
});

/** Illegal live/offline field combinations are excluded by this tagged state. */
export const PersistedStreamState = Schema.Union([OfflineStreamState, LiveStreamState]).check(
  Schema.makeFilter(
    (state) => {
      const checkpoint = state.transitionCheckpoint;

      if (checkpoint === null) return true;

      return state._tag === "LiveStream"
        ? checkpoint.transition === "online" &&
            checkpoint.streamId === state.streamId &&
            checkpoint.transitionAt === state.startedAt
        : checkpoint.transition === "offline" &&
            state.endedAt !== null &&
            checkpoint.transitionAt === state.endedAt;
    },
    { message: "Transition checkpoint must match its tagged stream state" },
  ),
);

/** Parsed persisted Stream Lifecycle state. */
export type PersistedStreamState = typeof PersistedStreamState.Type;

const LegacyTransitionIntent = Schema.Struct({
  _tag: Schema.Literals(["StreamOnlineIntent", "StreamOfflineIntent"]),
  eventId: EventId,
  streamSessionId: StreamId,
  transitionAt: IsoTimestamp,
  viewerPollScheduleId: Schema.NullOr(Schema.NonEmptyString),
  spotifyTokenNotified: Schema.Boolean,
  twitchTokenNotified: Schema.Boolean,
  lifecycleEventPublished: Schema.Boolean,
  viewerPollingUpdated: Schema.Boolean,
});

const LegacyTaggedStreamState = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("OfflineStream"),
    lastStartedAt: Schema.NullOr(IsoTimestamp),
    endedAt: Schema.NullOr(IsoTimestamp),
    peakViewerCount: NonNegativeInt,
    transitionIntent: Schema.optionalKey(Schema.NullOr(LegacyTransitionIntent)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("LiveStream"),
    streamSessionId: StreamId,
    startedAt: IsoTimestamp,
    peakViewerCount: NonNegativeInt,
    viewerPollScheduleId: Schema.NullOr(Schema.NonEmptyString),
    transitionIntent: Schema.optionalKey(Schema.NullOr(LegacyTransitionIntent)),
  }),
]);

const LegacyBooleanStreamState = Schema.Struct({
  isLive: Schema.Boolean,
  startedAt: Schema.NullOr(IsoTimestamp),
  endedAt: Schema.NullOr(IsoTimestamp),
  peakViewerCount: NonNegativeInt,
  streamSessionId: Schema.NullOr(StreamId),
  viewerPollScheduleId: Schema.NullOr(Schema.NonEmptyString),
});

const CurrentStreamStateEvidence = Schema.Struct({ transitionCheckpoint: Schema.Unknown });

const TaggedStreamStateEvidence = Schema.Struct({ _tag: Schema.Unknown });

const hasCurrentStreamStateEvidence = Schema.is(CurrentStreamStateEvidence);

const hasTaggedStreamStateEvidence = Schema.is(TaggedStreamStateEvidence);

const decodeCurrentStreamStateJson = Schema.decodeEffect(Schema.toCodecJson(PersistedStreamState));

const decodeLegacyTaggedStreamStateJson = Schema.decodeEffect(
  Schema.toCodecJson(LegacyTaggedStreamState),
);

const decodeLegacyBooleanStreamStateJson = Schema.decodeEffect(
  Schema.toCodecJson(LegacyBooleanStreamState),
);

/** Initial state used only when neither current nor legacy durable state exists. */
export const initialStreamState = (): PersistedStreamState => ({
  _tag: "OfflineStream",
  lastStartedAt: null,
  endedAt: null,
  peakViewerCount: 0,
  transitionCheckpoint: null,
});

const persistenceError = () =>
  new StreamLifecycleError({
    operation: "getState",
    reason: "stored_state_invalid",
  });

const checkpointFromLegacy = (
  intent: typeof LegacyTransitionIntent.Type | null | undefined,
): typeof StreamTransitionCheckpointRecord.Type | null =>
  intent === null || intent === undefined
    ? null
    : {
        eventId: intent.eventId,
        streamId: intent.streamSessionId,
        transition: intent._tag === "StreamOnlineIntent" ? "online" : "offline",
        transitionAt: intent.transitionAt,
        viewerPollScheduleId: intent.viewerPollScheduleId,
        spotifyTokenNotified: intent.spotifyTokenNotified,
        twitchTokenNotified: intent.twitchTokenNotified,
        lifecycleEventPublished: intent.lifecycleEventPublished,
        viewerPollingUpdated: intent.viewerPollingUpdated,
      };

const stateFromLegacyTagged = (
  legacy: typeof LegacyTaggedStreamState.Type,
): Effect.Effect<PersistedStreamState, StreamLifecycleError> => {
  const checkpoint = checkpointFromLegacy(legacy.transitionIntent);

  if (legacy._tag === "LiveStream") {
    if (
      checkpoint !== null &&
      (checkpoint.transition !== "online" ||
        checkpoint.streamId !== legacy.streamSessionId ||
        checkpoint.transitionAt !== legacy.startedAt)
    ) {
      return Effect.fail(persistenceError());
    }

    return Effect.succeed({
      _tag: "LiveStream",
      streamId: legacy.streamSessionId,
      startedAt: legacy.startedAt,
      peakViewerCount: legacy.peakViewerCount,
      viewerPollScheduleId: legacy.viewerPollScheduleId,
      transitionCheckpoint: checkpoint,
    });
  }

  if (
    checkpoint !== null &&
    (checkpoint.transition !== "offline" ||
      legacy.endedAt === null ||
      checkpoint.transitionAt !== legacy.endedAt)
  ) {
    return Effect.fail(persistenceError());
  }

  return Effect.succeed({
    _tag: "OfflineStream",
    lastStartedAt: legacy.lastStartedAt,
    endedAt: legacy.endedAt,
    peakViewerCount: legacy.peakViewerCount,
    transitionCheckpoint: checkpoint,
  });
};

const stateFromLegacyBoolean = (
  legacy: typeof LegacyBooleanStreamState.Type,
): Effect.Effect<PersistedStreamState, StreamLifecycleError> => {
  if (legacy.isLive) {
    if (legacy.startedAt === null || legacy.streamSessionId === null) {
      return Effect.fail(persistenceError());
    }

    return Effect.succeed({
      _tag: "LiveStream",
      streamId: legacy.streamSessionId,
      startedAt: legacy.startedAt,
      peakViewerCount: legacy.peakViewerCount,
      viewerPollScheduleId: legacy.viewerPollScheduleId,
      transitionCheckpoint: null,
    });
  }

  return Effect.succeed({
    _tag: "OfflineStream",
    lastStartedAt: legacy.startedAt,
    endedAt: legacy.endedAt,
    peakViewerCount: legacy.peakViewerCount,
    transitionCheckpoint: null,
  });
};

/** Decode current state or either historical Agent representation without resetting corruption. */
export const decodePersistedStreamState = (
  input: Schema.Json,
): Effect.Effect<PersistedStreamState, StreamLifecycleError> => {
  if (hasCurrentStreamStateEvidence(input)) {
    return decodeCurrentStreamStateJson(input).pipe(Effect.mapError(persistenceError));
  }

  if (hasTaggedStreamStateEvidence(input)) {
    return decodeLegacyTaggedStreamStateJson(input).pipe(
      Effect.flatMap(stateFromLegacyTagged),
      Effect.mapError(persistenceError),
    );
  }

  return decodeLegacyBooleanStreamStateJson(input).pipe(
    Effect.flatMap(stateFromLegacyBoolean),
    Effect.mapError(persistenceError),
  );
};

/** Public projection of persisted tagged state. */
export const toStreamLifecycleState = (state: PersistedStreamState): StreamLifecycleState =>
  state._tag === "LiveStream"
    ? {
        isLive: true,
        startedAt: Option.some(state.startedAt),
        endedAt: Option.none(),
        peakViewerCount: state.peakViewerCount,
      }
    : {
        isLive: false,
        startedAt: Option.fromNullOr(state.lastStartedAt),
        endedAt: Option.fromNullOr(state.endedAt),
        peakViewerCount: state.peakViewerCount,
      };

// IsoTimestamp validates calendar existence and Date.parse compatibility before this pure domain code.
const streamTimestampInstant = (timestamp: IsoTimestamp): DateTime.Utc =>
  DateTime.makeUnsafe(timestamp);

const streamTimestampFraction = (timestamp: IsoTimestamp): string => {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(timestamp)?.[1] ?? "";

  return fraction.replace(/0+$/, "");
};

// DateTime uses host millisecond precision, so exact accepted fractions break instant ties.
const compareStreamTimestampInstants: Order.Order<IsoTimestamp> = Order.combine(
  Order.mapInput(DateTime.Order, streamTimestampInstant),
  Order.mapInput(Order.String, streamTimestampFraction),
);

const streamTimestampIsBefore = (self: IsoTimestamp, that: IsoTimestamp): boolean =>
  compareStreamTimestampInstants(self, that) < 0;

/** Latest source timestamp used to reject stale lifecycle evidence by instant. */
const latestTransitionAt = (state: PersistedStreamState): IsoTimestamp | null => {
  if (state._tag === "LiveStream") return state.startedAt;

  if (state.lastStartedAt === null) return state.endedAt;

  if (state.endedAt === null) return state.lastStartedAt;

  return streamTimestampIsBefore(state.lastStartedAt, state.endedAt)
    ? state.endedAt
    : state.lastStartedAt;
};

/** Accept an online transition and atomically create all incomplete effect checkpoints. */
export const acceptOnlineTransition = (
  state: PersistedStreamState,
  input: {
    readonly eventId: EventId;
    readonly streamId: StreamId;
    readonly startedAt: IsoTimestamp;
  },
): PersistedStreamState => {
  const latest = latestTransitionAt(state);

  if (latest !== null && compareStreamTimestampInstants(input.startedAt, latest) <= 0) {
    return state;
  }

  if (state._tag === "LiveStream") return state;

  return {
    _tag: "LiveStream",
    streamId: input.streamId,
    startedAt: input.startedAt,
    peakViewerCount: state.peakViewerCount,
    viewerPollScheduleId: null,
    transitionCheckpoint: {
      eventId: input.eventId,
      streamId: input.streamId,
      transition: "online",
      transitionAt: input.startedAt,
      viewerPollScheduleId: null,
      spotifyTokenNotified: false,
      twitchTokenNotified: false,
      lifecycleEventPublished: false,
      viewerPollingUpdated: false,
    },
  };
};

/** Accept an offline transition and atomically create all incomplete effect checkpoints. */
export const acceptOfflineTransition = (
  state: PersistedStreamState,
  input: { readonly eventId: EventId; readonly endedAt: IsoTimestamp },
): PersistedStreamState => {
  const latest = latestTransitionAt(state);

  if (latest !== null && streamTimestampIsBefore(input.endedAt, latest)) return state;

  if (state._tag === "OfflineStream") return state;

  return {
    _tag: "OfflineStream",
    lastStartedAt: state.startedAt,
    endedAt: input.endedAt,
    peakViewerCount: state.peakViewerCount,
    transitionCheckpoint: {
      eventId: input.eventId,
      streamId: state.streamId,
      transition: "offline",
      transitionAt: input.endedAt,
      viewerPollScheduleId: state.viewerPollScheduleId,
      spotifyTokenNotified: false,
      twitchTokenNotified: false,
      lifecycleEventPublished: false,
      viewerPollingUpdated: false,
    },
  };
};

/** Mark one transition effect complete only for its stable event identity. */
export const completeTransitionEffect = (
  state: PersistedStreamState,
  eventId: EventId,
  effect: keyof Pick<
    StreamTransitionCheckpoint,
    | "spotifyTokenNotified"
    | "twitchTokenNotified"
    | "lifecycleEventPublished"
    | "viewerPollingUpdated"
  >,
): PersistedStreamState => {
  const checkpoint = state.transitionCheckpoint;

  if (checkpoint === null || checkpoint.eventId !== eventId) return state;

  return {
    ...state,
    transitionCheckpoint: { ...checkpoint, [effect]: true },
  };
};

/** Clear checkpoint evidence only after all four durable effects completed. */
export const clearCompletedTransition = (state: PersistedStreamState): PersistedStreamState => {
  const checkpoint = state.transitionCheckpoint;

  if (
    checkpoint === null ||
    !checkpoint.spotifyTokenNotified ||
    !checkpoint.twitchTokenNotified ||
    !checkpoint.lifecycleEventPublished ||
    !checkpoint.viewerPollingUpdated
  ) {
    return state;
  }

  return { ...state, transitionCheckpoint: null };
};
