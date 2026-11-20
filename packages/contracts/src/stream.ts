import { Effect, Option, Schema } from "effect";
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

/** Stream Lifecycle operation names recorded on typed Stream Lifecycle failures. */
export const StreamLifecycleOperation = Schema.Literals([
  "getState",
  "saveState",
  "markOnline",
  "markOffline",
  "recordViewerCount",
  "pollViewerCount",
  "getViewerHistory",
  "reconcile",
  "resumeTransitionEffects",
  "rebuildAlarm",
  "scheduleAlarm",
  "clearAlarm",
  "migrateLegacyState",
  "getStatus",
  "getDebugState",
  "reset",
]);

/** Stream Lifecycle operation name recorded on typed Stream Lifecycle failures. */
export type StreamLifecycleOperation = typeof StreamLifecycleOperation.Type;

/** Classified cause of a Stream Lifecycle failure. */
export const StreamLifecycleFailureReason = Schema.Literals([
  "persistence_unavailable",
  "stored_state_invalid",
  "invalid_response",
  "effects_pending",
  "provider_unavailable",
]);

/** Classified cause of a Stream Lifecycle failure. */
export type StreamLifecycleFailureReason = typeof StreamLifecycleFailureReason.Type;

/**
 * Expected failure while applying Stream Lifecycle state or its durable transition effects.
 *
 * **Details**
 *
 * Accepted transitions persist their checkpoints before any effect runs, and duplicate source
 * evidence is ignored, so retrying the same request resumes rather than repeats a transition.
 */
export class StreamLifecycleError extends Schema.TaggedError<StreamLifecycleError>()(
  "StreamLifecycleError",
  {
    operation: StreamLifecycleOperation,
    reason: StreamLifecycleFailureReason,
    streamId: Schema.OptionFromNullOr(StreamId).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none<StreamId>())),
    ),
  },
) {
  /** Message naming the failed operation and reason, without provider or stored payloads. */
  override get message(): string {
    switch (this.reason) {
      case "persistence_unavailable":
        return `Stream Lifecycle storage was unavailable during ${this.operation}. Retry the same request; accepted transitions resume from their saved checkpoints.`;
      case "stored_state_invalid":
        return `Stream Lifecycle stored state failed validation during ${this.operation}. Inspect the stored Stream Lifecycle state before retrying.`;
      case "invalid_response":
        return `Stream Lifecycle response failed validation during ${this.operation}. Read the Stream Lifecycle state to confirm the outcome before retrying.`;
      case "effects_pending":
        return `Stream Lifecycle transition effects are still pending after ${this.operation}. Retry the same request to resume the saved transition checkpoint.`;
      case "provider_unavailable":
        return `Stream Lifecycle could not read the Twitch viewer count during ${this.operation}. Retry after Twitch is reachable.`;
    }
  }
}
