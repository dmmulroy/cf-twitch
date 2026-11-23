import {
  DateTime,
  Effect,
  Match,
  Option,
  Order,
  Predicate,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { EventId, IsoTimestamp, NonNegativeInt, StreamId } from "@cf-twitch/contracts/identity";
import {
  StreamLifecycleError,
  type StreamLifecycleState,
  type StreamTransitionCheckpoint,
} from "@cf-twitch/contracts/stream";

/** Schema for the persisted checkpoint of one accepted transition and its four durable effects. */
const StreamTransitionCheckpointRecord = Schema.Struct({
  eventId: EventId,
  streamId: StreamId,
  transition: Schema.Literals(["online", "offline"]),
  transitionAt: IsoTimestamp,
  viewerPollScheduleId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  spotifyTokenNotified: Schema.Boolean,
  twitchTokenNotified: Schema.Boolean,
  lifecycleEventPublished: Schema.Boolean,
  viewerPollingUpdated: Schema.Boolean,
});

/** Schema for persisted Stream Lifecycle state while no Stream Session is active. */
export const OfflineStreamState = Schema.TaggedStruct("OfflineStream", {
  /** Start of the most recent Stream Session, absent before the first one. */
  lastStartedAt: Schema.OptionFromNullOr(IsoTimestamp),
  /** End of the most recent Stream Session, absent before the first one ends. */
  endedAt: Schema.OptionFromNullOr(IsoTimestamp),
  peakViewerCount: NonNegativeInt,
  /** Checkpoint of an accepted offline transition whose effects are incomplete. */
  transitionCheckpoint: Schema.OptionFromNullOr(StreamTransitionCheckpointRecord),
  /**
   * Stream whose newer start ended the most recent Stream Session, or `Option.none()` when an
   * offline notification or reconciliation ended it. Absent in rows written before supersession.
   */
  supersedingStreamId: Schema.OptionFromOptionalKey(StreamId),
});

/** Schema for persisted Stream Lifecycle state while one Stream Session is active. */
export const LiveStreamState = Schema.TaggedStruct("LiveStream", {
  streamId: StreamId,
  startedAt: IsoTimestamp,
  peakViewerCount: NonNegativeInt,
  /** Instant of the next viewer poll alarm, absent until polling is scheduled. */
  viewerPollScheduleId: Schema.OptionFromNullOr(Schema.NonEmptyString),
  /** Checkpoint of an accepted online transition whose effects are incomplete. */
  transitionCheckpoint: Schema.OptionFromNullOr(StreamTransitionCheckpointRecord),
  /**
   * Start of the Stream Session this one superseded while that session's offline notification is
   * still outstanding, or `Option.none()`. Absent in rows written before supersession.
   */
  supersededStartedAt: Schema.OptionFromOptionalKey(IsoTimestamp),
});

/** Returns whether a checkpoint belongs to the tagged state it is stored on. */
const checkpointMatchesStreamState = (
  state: typeof OfflineStreamState.Type | typeof LiveStreamState.Type,
): boolean =>
  Option.match(state.transitionCheckpoint, {
    onNone: () => true,
    onSome: (checkpoint) =>
      Predicate.isTagged("LiveStream")(state)
        ? checkpoint.transition === "online" &&
          checkpoint.streamId === state.streamId &&
          checkpoint.transitionAt === state.startedAt
        : checkpoint.transition === "offline" &&
          Option.contains(state.endedAt, checkpoint.transitionAt),
  });

/**
 * Schema for persisted Stream Lifecycle state, excluding illegal live/offline field combinations.
 *
 * **Details**
 *
 * Absent values encode as JSON `null`, matching every stored row written before Option fields.
 */
export const PersistedStreamState = Schema.Union([OfflineStreamState, LiveStreamState]).check(
  Schema.makeFilter(checkpointMatchesStreamState, {
    message:
      "Stream Lifecycle transition checkpoint does not match its tagged state. Inspect the stored Stream Lifecycle state before retrying.",
  }),
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
  Schema.TaggedStruct("OfflineStream", {
    lastStartedAt: Schema.NullOr(IsoTimestamp),
    endedAt: Schema.NullOr(IsoTimestamp),
    peakViewerCount: NonNegativeInt,
    transitionIntent: Schema.optionalKey(Schema.NullOr(LegacyTransitionIntent)),
  }),
  Schema.TaggedStruct("LiveStream", {
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

/** Returns the current checkpoint for a legacy Agent transition intent, if one was pending. */
const checkpointFromLegacyIntent = (
  intent: typeof LegacyTransitionIntent.Type | null | undefined,
): Option.Option<typeof StreamTransitionCheckpointRecord.Type> =>
  Option.map(Option.fromNullishOr(intent), (pending) => ({
    eventId: pending.eventId,
    streamId: pending.streamSessionId,
    transition: Predicate.isTagged("StreamOnlineIntent")(pending) ? "online" : "offline",
    transitionAt: pending.transitionAt,
    viewerPollScheduleId: Option.fromNullOr(pending.viewerPollScheduleId),
    spotifyTokenNotified: pending.spotifyTokenNotified,
    twitchTokenNotified: pending.twitchTokenNotified,
    lifecycleEventPublished: pending.lifecycleEventPublished,
    viewerPollingUpdated: pending.viewerPollingUpdated,
  }));

/** Message for the forbidden encode direction: legacy Agent formats are read, never written. */
const legacyStreamStateEncodeForbidden = () =>
  "Stream Lifecycle state cannot be encoded in a legacy Agent format. Encode it with the current PersistedStreamState schema.";

// Decoding into the type side still runs the union's checkpoint filter, so a legacy intent must
// agree with its tagged state exactly as current rows must.
const PersistedStreamStateFromLegacyTagged = Schema.toCodecJson(LegacyTaggedStreamState).pipe(
  Schema.decodeTo(Schema.toType(PersistedStreamState), {
    decode: SchemaGetter.transform((legacy): PersistedStreamState =>
      Predicate.isTagged("LiveStream")(legacy)
        ? LiveStreamState.make({
            streamId: legacy.streamSessionId,
            startedAt: legacy.startedAt,
            peakViewerCount: legacy.peakViewerCount,
            viewerPollScheduleId: Option.fromNullOr(legacy.viewerPollScheduleId),
            transitionCheckpoint: checkpointFromLegacyIntent(legacy.transitionIntent),
            supersededStartedAt: Option.none(),
          })
        : OfflineStreamState.make({
            lastStartedAt: Option.fromNullOr(legacy.lastStartedAt),
            endedAt: Option.fromNullOr(legacy.endedAt),
            peakViewerCount: legacy.peakViewerCount,
            transitionCheckpoint: checkpointFromLegacyIntent(legacy.transitionIntent),
            supersedingStreamId: Option.none(),
          }),
    ),
    encode: SchemaGetter.forbidden(legacyStreamStateEncodeForbidden),
  }),
);

const PersistedStreamStateFromLegacyBoolean = Schema.toCodecJson(LegacyBooleanStreamState).pipe(
  Schema.decodeTo(Schema.toType(PersistedStreamState), {
    decode: SchemaGetter.transformEffect((legacy) => {
      if (!legacy.isLive)
        return Effect.succeed<PersistedStreamState>(
          OfflineStreamState.make({
            lastStartedAt: Option.fromNullOr(legacy.startedAt),
            endedAt: Option.fromNullOr(legacy.endedAt),
            peakViewerCount: legacy.peakViewerCount,
            transitionCheckpoint: Option.none(),
            supersedingStreamId: Option.none(),
          }),
        );

      if (legacy.startedAt === null || legacy.streamSessionId === null)
        return Effect.fail(
          new SchemaIssue.InvalidValue(
            {
              message:
                "Legacy live Stream Lifecycle state is missing its start time or session ID. Inspect the legacy Agent state row before retrying adoption.",
            },
            legacy,
          ),
        );

      return Effect.succeed<PersistedStreamState>(
        LiveStreamState.make({
          streamId: legacy.streamSessionId,
          startedAt: legacy.startedAt,
          peakViewerCount: legacy.peakViewerCount,
          viewerPollScheduleId: Option.fromNullOr(legacy.viewerPollScheduleId),
          transitionCheckpoint: Option.none(),
          supersededStartedAt: Option.none(),
        }),
      );
    }),
    encode: SchemaGetter.forbidden(legacyStreamStateEncodeForbidden),
  }),
);

const CurrentStreamStateEvidence = Schema.Struct({ transitionCheckpoint: Schema.Unknown });

const TaggedStreamStateEvidence = Schema.Struct({ _tag: Schema.Unknown });

const hasCurrentStreamStateEvidence = Schema.is(CurrentStreamStateEvidence);

const hasTaggedStreamStateEvidence = Schema.is(TaggedStreamStateEvidence);

const decodeCurrentStreamStateJson = Schema.decodeUnknownEffect(
  Schema.toCodecJson(PersistedStreamState),
);

const decodeLegacyTaggedStreamStateJson = Schema.decodeUnknownEffect(
  PersistedStreamStateFromLegacyTagged,
);

const decodeLegacyBooleanStreamStateJson = Schema.decodeUnknownEffect(
  PersistedStreamStateFromLegacyBoolean,
);

/** Returns the initial state, used only when neither current nor legacy durable state exists. */
export const initialStreamState = (): PersistedStreamState =>
  OfflineStreamState.make({
    lastStartedAt: Option.none(),
    endedAt: Option.none(),
    peakViewerCount: 0,
    transitionCheckpoint: Option.none(),
    supersedingStreamId: Option.none(),
  });

/**
 * Parses Stream Lifecycle state from the Agent JSON row, in its current or either historical shape.
 *
 * **Details**
 *
 * The representation is selected by evidence: a `transitionCheckpoint` key means current state, a
 * `_tag` key means the tagged Agent format, otherwise the boolean Agent format. A parse failure
 * never falls through to a weaker representation.
 *
 * @param input - Parsed JSON from the `cf_agents_state` row.
 * @returns The parsed state, or fails with `StreamLifecycleError` whose reason is
 *   `stored_state_invalid` when the selected representation is malformed.
 */
export const decodePersistedStreamState = (
  input: Schema.Json,
): Effect.Effect<PersistedStreamState, StreamLifecycleError> => {
  const decoded = hasCurrentStreamStateEvidence(input)
    ? decodeCurrentStreamStateJson(input)
    : hasTaggedStreamStateEvidence(input)
      ? decodeLegacyTaggedStreamStateJson(input)
      : decodeLegacyBooleanStreamStateJson(input);

  return decoded.pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new StreamLifecycleError({
          operation: "migrateLegacyState",
          reason: "stored_state_invalid",
        }),
      ),
    ),
  );
};

/** Returns the public Stream Lifecycle State projection of persisted tagged state. */
export const toStreamLifecycleState = (state: PersistedStreamState): StreamLifecycleState =>
  Match.value(state).pipe(
    Match.tagsExhaustive({
      LiveStream: (live) => ({
        isLive: true,
        startedAt: Option.some(live.startedAt),
        endedAt: Option.none(),
        peakViewerCount: live.peakViewerCount,
      }),
      OfflineStream: (offline) => ({
        isLive: false,
        startedAt: offline.lastStartedAt,
        endedAt: offline.endedAt,
        peakViewerCount: offline.peakViewerCount,
      }),
    }),
  );

/**
 * Derives the stable UUID of a lifecycle domain event from accepted transition evidence.
 *
 * **Details**
 *
 * The same transition, Stream ID, and source time always produce the same ID, so a resumed
 * publication is deduplicated downstream.
 *
 * @returns The event ID; fails with no typed error.
 * @throws {PlatformError} As a defect when the SHA-256 digest primitive is unavailable.
 */
export const deriveStreamLifecycleEventId = Effect.fn(
  "StreamLifecycle.deriveStreamLifecycleEventId",
)(function* (input: {
  readonly transition: "online" | "offline";
  readonly streamId: StreamId;
  readonly transitionAt: IsoTimestamp;
}) {
  const digestService = yield* Digest.Digest;

  const digest = yield* digestService.digest(
    Digest.sha256,
    new TextEncoder().encode(
      `cf-twitch:stream-lifecycle:${input.transition}:${input.streamId}:${input.transitionAt}`,
    ),
  );

  const uuidBytes = digest.slice(0, 16);
  uuidBytes[6] = ((uuidBytes[6] ?? 0) & 0x0f) | 0x50;
  uuidBytes[8] = ((uuidBytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Hex.encode(uuidBytes);

  return EventId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
});

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

/**
 * Window after a superseding Stream Session starts in which an offline notification is attributed
 * to the superseded session, whose notification Twitch may deliver after the newer online one.
 */
const SUPERSEDED_OFFLINE_WINDOW_MS = 10 * 60_000;

/**
 * Returns the start of the most recent Stream Session, which orders online evidence.
 *
 * **Details**
 *
 * Twitch's online `started_at` is authoritative, while an offline time is only the signed
 * notification time, which can follow the start of the next broadcast. Rows from before session
 * starts were recorded fall back to the offline time.
 */
const latestSessionStart = (state: PersistedStreamState): Option.Option<IsoTimestamp> => {
  if (Predicate.isTagged("LiveStream")(state)) return Option.some(state.startedAt);

  return Option.orElse(state.lastStartedAt, () => state.endedAt);
};

/**
 * Accepts online evidence for a Stream Session newer than the most recent one, creating its
 * incomplete checkpoint.
 *
 * **Details**
 *
 * When the most recent session was ended by this stream's supersession, the new live state records
 * the superseded start so the superseded session's late offline notification is not applied.
 *
 * @returns The live state with all four effects incomplete, or the same state object when the
 *   evidence is stale, a duplicate, or the stream is already live. A newer stream arriving while
 *   live is handled by `acceptSupersedingSession`.
 */
export const acceptOnlineTransition = (
  state: PersistedStreamState,
  input: {
    readonly eventId: EventId;
    readonly streamId: StreamId;
    readonly startedAt: IsoTimestamp;
  },
): PersistedStreamState => {
  if (Predicate.isTagged("LiveStream")(state)) return state;
  const latest = latestSessionStart(state);

  if (Option.isSome(latest) && compareStreamTimestampInstants(input.startedAt, latest.value) <= 0) {
    return state;
  }

  return LiveStreamState.make({
    streamId: input.streamId,
    startedAt: input.startedAt,
    peakViewerCount: state.peakViewerCount,
    viewerPollScheduleId: Option.none(),
    transitionCheckpoint: Option.some({
      eventId: input.eventId,
      streamId: input.streamId,
      transition: "online",
      transitionAt: input.startedAt,
      viewerPollScheduleId: Option.none(),
      spotifyTokenNotified: false,
      twitchTokenNotified: false,
      lifecycleEventPublished: false,
      viewerPollingUpdated: false,
    }),
    supersededStartedAt: Option.contains(state.supersedingStreamId, input.streamId)
      ? state.lastStartedAt
      : Option.none(),
  });
};

/** Returns the offline state that ends a live session, with all four effects of its checkpoint incomplete. */
const offlineFromLiveSession = (
  live: typeof LiveStreamState.Type,
  input: { readonly eventId: EventId; readonly endedAt: IsoTimestamp },
  supersedingStreamId: Option.Option<StreamId>,
): PersistedStreamState =>
  OfflineStreamState.make({
    lastStartedAt: Option.some(live.startedAt),
    endedAt: Option.some(input.endedAt),
    peakViewerCount: live.peakViewerCount,
    transitionCheckpoint: Option.some({
      eventId: input.eventId,
      streamId: live.streamId,
      transition: "offline",
      transitionAt: input.endedAt,
      viewerPollScheduleId: live.viewerPollScheduleId,
      spotifyTokenNotified: false,
      twitchTokenNotified: false,
      lifecycleEventPublished: false,
      viewerPollingUpdated: false,
    }),
    supersedingStreamId,
  });

/** Returns whether a live state should be ended by a different stream that started after it. */
export const isSupersedingStream = (
  state: PersistedStreamState,
  stream: { readonly streamId: StreamId; readonly startedAt: IsoTimestamp },
): boolean =>
  Predicate.isTagged("LiveStream")(state) &&
  state.streamId !== stream.streamId &&
  streamTimestampIsBefore(state.startedAt, stream.startedAt);

/**
 * Ends the live Stream Session because a different, newer stream started, creating its offline
 * checkpoint.
 *
 * **Details**
 *
 * Twitch ended the previous broadcast no later than the newer stream's start, so that start is the
 * offline time. The offline state names the superseding stream, so accepting its online evidence
 * next still ignores the superseded session's late offline notification after a restart.
 *
 * @returns The offline state with all four effects incomplete, or the same state object when the
 *   stream does not supersede the live session.
 */
export const acceptSupersedingSession = (
  state: PersistedStreamState,
  input: {
    readonly eventId: EventId;
    readonly streamId: StreamId;
    readonly startedAt: IsoTimestamp;
  },
): PersistedStreamState =>
  Predicate.isTagged("LiveStream")(state) && isSupersedingStream(state, input)
    ? offlineFromLiveSession(
        state,
        { eventId: input.eventId, endedAt: input.startedAt },
        Option.some(input.streamId),
      )
    : state;

/** Returns whether an offline notification belongs to the session the live one superseded. */
const isSupersededSessionOffline = (
  live: typeof LiveStreamState.Type,
  endedAt: IsoTimestamp,
): boolean =>
  Option.isSome(live.supersededStartedAt) &&
  DateTime.toEpochMillis(streamTimestampInstant(endedAt)) <=
    DateTime.toEpochMillis(streamTimestampInstant(live.startedAt)) + SUPERSEDED_OFFLINE_WINDOW_MS;

/**
 * Accepts offline evidence not older than the live Stream Session, creating its checkpoint.
 *
 * **Details**
 *
 * Twitch offline notifications do not name their stream. When the live session superseded another
 * whose notification is outstanding, the first offline notification no later than ten minutes after
 * the live start is attributed to the superseded session: it clears the marker and leaves the live
 * session running.
 *
 * @returns The offline state with all four effects incomplete, the live state without its
 *   superseded marker, or the same state object when the evidence is stale or the stream is already
 *   offline.
 */
export const acceptOfflineTransition = (
  state: PersistedStreamState,
  input: { readonly eventId: EventId; readonly endedAt: IsoTimestamp },
): PersistedStreamState => {
  if (Predicate.isTagged("OfflineStream")(state)) return state;

  if (isSupersededSessionOffline(state, input.endedAt))
    return { ...state, supersededStartedAt: Option.none() };

  if (streamTimestampIsBefore(input.endedAt, state.startedAt)) return state;

  return offlineFromLiveSession(state, input, Option.none());
};

/** Durable transition effect whose completion is recorded on the transition checkpoint. */
export type StreamTransitionEffect = keyof Pick<
  StreamTransitionCheckpoint,
  | "spotifyTokenNotified"
  | "twitchTokenNotified"
  | "lifecycleEventPublished"
  | "viewerPollingUpdated"
>;

/** Returns the state with one transition effect marked complete, only for the matching event ID. */
export const completeTransitionEffect = (
  state: PersistedStreamState,
  eventId: EventId,
  effect: StreamTransitionEffect,
): PersistedStreamState => {
  const checkpoint = state.transitionCheckpoint;

  if (Option.isNone(checkpoint) || checkpoint.value.eventId !== eventId) return state;

  return {
    ...state,
    transitionCheckpoint: Option.some({ ...checkpoint.value, [effect]: true }),
  };
};

/** Returns the state without its checkpoint once all four durable effects have completed. */
export const clearCompletedTransition = (state: PersistedStreamState): PersistedStreamState => {
  const checkpoint = state.transitionCheckpoint;

  if (
    Option.isNone(checkpoint) ||
    !checkpoint.value.spotifyTokenNotified ||
    !checkpoint.value.twitchTokenNotified ||
    !checkpoint.value.lifecycleEventPublished ||
    !checkpoint.value.viewerPollingUpdated
  ) {
    return state;
  }

  return { ...state, transitionCheckpoint: Option.none() };
};
