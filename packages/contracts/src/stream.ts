import { Schema } from "effect";
import { EventId, IsoTimestamp, NonNegativeInt, StreamId } from "./identity.ts";

const ViewerHistoryLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(1_000),
);

/** Canonical singleton key for the Stream Lifecycle Durable Object. */
export const STREAM_LIFECYCLE_SINGLETON_KEY = "stream-lifecycle";

/** Current durable evidence about the active or most recent Stream Session. */
export const StreamLifecycleState = Schema.Struct({
  isLive: Schema.Boolean,
  startedAt: Schema.OptionFromNullOr(IsoTimestamp),
  endedAt: Schema.OptionFromNullOr(IsoTimestamp),
  peakViewerCount: NonNegativeInt,
});

/** Current durable evidence about the active or most recent Stream Session. */
export type StreamLifecycleState = typeof StreamLifecycleState.Type;

/** Authoritative Twitch evidence that a Stream Session is online. */
export const MarkStreamOnlineInput = Schema.Struct({
  streamId: StreamId,
  startedAt: IsoTimestamp,
});

/** Authoritative Twitch evidence that a Stream Session is online. */
export type MarkStreamOnlineInput = typeof MarkStreamOnlineInput.Type;

/** Authoritative EventSub evidence that a Stream Session ended. */
export const MarkStreamOfflineInput = Schema.Struct({
  endedAt: IsoTimestamp,
});

/** Authoritative EventSub evidence that a Stream Session ended. */
export type MarkStreamOfflineInput = typeof MarkStreamOfflineInput.Type;

/** One observed Viewer count at an explicit source timestamp. */
export const RecordViewerCountInput = Schema.Struct({
  count: NonNegativeInt,
  recordedAt: IsoTimestamp,
});

/** One observed Viewer count at an explicit source timestamp. */
export type RecordViewerCountInput = typeof RecordViewerCountInput.Type;

/** One persisted Viewer-count observation. */
export const ViewerCountSnapshot = Schema.Struct({
  timestamp: IsoTimestamp,
  viewerCount: NonNegativeInt,
});

/** One persisted Viewer-count observation. */
export type ViewerCountSnapshot = typeof ViewerCountSnapshot.Type;

/** Bounded viewer-history query with optional time bounds. */
export const ViewerHistoryInput = Schema.Struct({
  since: Schema.OptionFromNullOr(IsoTimestamp),
  until: Schema.OptionFromNullOr(IsoTimestamp),
  limit: ViewerHistoryLimit,
  offset: NonNegativeInt,
});

/** Bounded viewer-history query with optional time bounds. */
export type ViewerHistoryInput = typeof ViewerHistoryInput.Type;

/** A chronological page of Viewer-count observations. */
export const ViewerHistory = Schema.Struct({
  snapshots: Schema.Array(ViewerCountSnapshot),
  totalCount: NonNegativeInt,
  limit: ViewerHistoryLimit,
  offset: NonNegativeInt,
});

/** A chronological page of Viewer-count observations. */
export type ViewerHistory = typeof ViewerHistory.Type;

/** Twitch provider evidence used to reconcile Stream Lifecycle state. */
export const StreamProviderState = Schema.Struct({
  stream: Schema.OptionFromNullOr(
    Schema.Struct({
      id: StreamId,
      startedAt: IsoTimestamp,
      viewerCount: NonNegativeInt,
    }),
  ),
  observedAt: IsoTimestamp,
});

/** Twitch provider evidence used to reconcile Stream Lifecycle state. */
export type StreamProviderState = typeof StreamProviderState.Type;

/** Observable action selected while reconciling Twitch and durable state. */
export const StreamReconciliationAction = Schema.Literals([
  "noop",
  "marked_online",
  "marked_offline",
  "recorded_viewer_count",
]);

/** Observable action selected while reconciling Twitch and durable state. */
export type StreamReconciliationAction = typeof StreamReconciliationAction.Type;

/** Result of reconciling provider evidence with durable Stream Lifecycle state. */
export const StreamReconciliationResult = Schema.Struct({
  action: StreamReconciliationAction,
  before: StreamLifecycleState,
  after: StreamLifecycleState,
});

/** Result of reconciling provider evidence with durable Stream Lifecycle state. */
export type StreamReconciliationResult = typeof StreamReconciliationResult.Type;

/** Durable completion evidence for one accepted Stream Lifecycle transition. */
export const StreamTransitionCheckpoint = Schema.Struct({
  eventId: EventId,
  streamId: StreamId,
  transition: Schema.Literals(["online", "offline"]),
  transitionAt: IsoTimestamp,
  spotifyTokenNotified: Schema.Boolean,
  twitchTokenNotified: Schema.Boolean,
  lifecycleEventPublished: Schema.Boolean,
  viewerPollingUpdated: Schema.Boolean,
});

/** Durable completion evidence for one accepted Stream Lifecycle transition. */
export type StreamTransitionCheckpoint = typeof StreamTransitionCheckpoint.Type;

/** Stream Lifecycle persistence and pending-effect diagnostics. */
export const StreamLifecycleDebugState = Schema.Struct({
  state: StreamLifecycleState,
  activeStreamId: Schema.OptionFromNullOr(StreamId),
  transitionCheckpoint: Schema.OptionFromNullOr(StreamTransitionCheckpoint),
  viewerSnapshotCount: NonNegativeInt,
});

/** Stream Lifecycle persistence and pending-effect diagnostics. */
export type StreamLifecycleDebugState = typeof StreamLifecycleDebugState.Type;

/** Stream Lifecycle readiness and pending-effect status. */
export const StreamLifecycleStatus = Schema.Struct({
  healthy: Schema.Boolean,
  effectsPending: Schema.Boolean,
  state: StreamLifecycleState,
});

/** Stream Lifecycle readiness and pending-effect status. */
export type StreamLifecycleStatus = typeof StreamLifecycleStatus.Type;

/** Stream Lifecycle operation names included in typed failures. */
export const StreamLifecycleOperation = Schema.Literals([
  "getState",
  "markOnline",
  "markOffline",
  "recordViewerCount",
  "getViewerHistory",
  "reconcile",
  "resumeTransitionEffects",
  "getStatus",
  "getDebugState",
  "reset",
]);

/** Stream Lifecycle operation name. */
export type StreamLifecycleOperation = typeof StreamLifecycleOperation.Type;

/** Expected failure while applying Stream Lifecycle state or durable effects. */
export class StreamLifecycleError extends Schema.TaggedError<StreamLifecycleError>()(
  "StreamLifecycleError",
  {
    operation: StreamLifecycleOperation,
    reason: Schema.Literals([
      "persistence_unavailable",
      "stored_state_invalid",
      "invalid_response",
      "effects_pending",
      "provider_unavailable",
    ]),
  },
) {
  /** Stable Stream Lifecycle failure description excludes provider and stored payloads. */
  override get message(): string {
    return `Stream Lifecycle ${this.operation} failed (${this.reason})`;
  }
}
