import { Context, type Effect } from "effect";
import type {
  MarkStreamOfflineInput,
  MarkStreamOnlineInput,
  RecordViewerCountInput,
  StreamLifecycleDebugState,
  StreamLifecycleError,
  StreamLifecycleState,
  StreamLifecycleStatus,
  StreamProviderState,
  StreamReconciliationResult,
  ViewerHistory,
  ViewerHistoryInput,
} from "@cf-twitch/contracts/stream";

/** Application-facing operations owned by the Stream Lifecycle singleton. */
export interface IStreamLifecycleClient {
  readonly getState: () => Effect.Effect<StreamLifecycleState, StreamLifecycleError>;
  readonly markOnline: (
    input: MarkStreamOnlineInput,
  ) => Effect.Effect<StreamLifecycleState, StreamLifecycleError>;
  readonly markOffline: (
    input: MarkStreamOfflineInput,
  ) => Effect.Effect<StreamLifecycleState, StreamLifecycleError>;
  readonly recordViewerCount: (
    input: RecordViewerCountInput,
  ) => Effect.Effect<void, StreamLifecycleError>;
  readonly getViewerHistory: (
    input: ViewerHistoryInput,
  ) => Effect.Effect<ViewerHistory, StreamLifecycleError>;
  readonly reconcile: (
    input: StreamProviderState,
  ) => Effect.Effect<StreamReconciliationResult, StreamLifecycleError>;
  readonly getStatus: () => Effect.Effect<StreamLifecycleStatus, StreamLifecycleError>;
  readonly getDebugState: () => Effect.Effect<StreamLifecycleDebugState, StreamLifecycleError>;
  readonly reset: () => Effect.Effect<void, StreamLifecycleError>;
}

/** Shared Stream Lifecycle client service backed by the preserved singleton namespace. */
export class StreamLifecycleClient extends Context.Service<
  StreamLifecycleClient,
  IStreamLifecycleClient
>()("@cf-twitch/StreamLifecycleClient") {}
