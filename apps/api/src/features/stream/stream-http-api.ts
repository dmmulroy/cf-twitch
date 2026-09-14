import { Schema } from "effect";
import {
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
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

const UnitSuccess = Schema.Struct({ success: Schema.Literal(true) });

/** Versioned Stream Lifecycle endpoints shared by server and client. */
export class StreamLifecycleHttpApiGroup extends HttpApiGroup.make("streamLifecycle")
  .add(
    HttpApiEndpoint.get("getState", "/stream", {
      success: StreamLifecycleState,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.post("markOnline", "/stream/online", {
      payload: MarkStreamOnlineInput,
      success: StreamLifecycleState,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.post("markOffline", "/stream/offline", {
      payload: MarkStreamOfflineInput,
      success: StreamLifecycleState,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.post("recordViewerCount", "/stream/viewers", {
      payload: RecordViewerCountInput,
      success: UnitSuccess,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getViewerHistory", "/stream/viewers/history", {
      payload: ViewerHistoryInput,
      success: ViewerHistory,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.post("reconcile", "/stream/reconcile", {
      payload: StreamProviderState,
      success: StreamReconciliationResult,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getStatus", "/stream/status", {
      success: StreamLifecycleStatus,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getDebugState", "/stream/debug", {
      success: StreamLifecycleDebugState,
      error: StreamLifecycleError,
    }),
  )
  .add(
    HttpApiEndpoint.post("reset", "/stream/reset", {
      success: UnitSuccess,
      error: StreamLifecycleError,
    }),
  ) {}

/** Internal HTTP API hosted by the physical StreamLifecycleDO class. */
export class StreamLifecycleHttpApi extends HttpApi.make("StreamLifecycleHttpApi")
  .add(StreamLifecycleHttpApiGroup)
  .prefix("/v1") {}
