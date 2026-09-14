import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  NowPlaying,
  PendingSongRequest,
  RequestHistoryQuery,
  RequestHistoryResult,
  SongQueueDisplayNameInput,
  SongQueueDuplicateInput,
  SongQueueError,
  SongQueueLimitInput,
  SongQueueResult,
  SongQueueSessionInput,
  SongQueueViewerInput,
  SongQueueViewerTracksInput,
  SongRequestIdentityInput,
  TopRequestedTrack,
  TopSongRequester,
} from "@cf-twitch/contracts/song-queue";

/** Song queue HTTP endpoints are private versioned operations, not the public Twitch API URLs. */
export class SongQueueHttpApiGroup extends HttpApiGroup.make("songQueue")
  .add(
    HttpApiEndpoint.post("persistRequest", "/requests", {
      payload: PendingSongRequest,
      success: Schema.Void,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteRequest", "/requests/delete", {
      payload: SongRequestIdentityInput,
      success: Schema.Void,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getSongQueue", "/queue", {
      payload: SongQueueLimitInput,
      success: SongQueueResult,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getCurrentlyPlaying", "/now-playing", {
      success: NowPlaying,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getRequestHistory", "/history", {
      payload: RequestHistoryQuery,
      success: RequestHistoryResult,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getUserRequestCount", "/counts/viewer", {
      payload: SongQueueViewerInput,
      success: Schema.Number,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getUserRequestCountByDisplayName", "/counts/display-name", {
      payload: SongQueueDisplayNameInput,
      success: Schema.Number,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getSessionRequestCount", "/counts/session", {
      payload: SongQueueSessionInput,
      success: Schema.Number,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getTopTracks", "/top/tracks", {
      payload: SongQueueLimitInput,
      success: Schema.Array(TopRequestedTrack),
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getTopTracksByUser", "/top/viewer-tracks", {
      payload: SongQueueViewerTracksInput,
      success: Schema.Array(TopRequestedTrack),
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getTopRequesters", "/top/requesters", {
      payload: SongQueueLimitInput,
      success: Schema.Array(TopSongRequester),
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("checkDuplicateRequest", "/requests/duplicate", {
      payload: SongQueueDuplicateInput,
      success: Schema.Boolean,
      error: SongQueueError,
    }),
  )
  .add(
    HttpApiEndpoint.post("refreshQueue", "/refresh", {
      success: Schema.Void,
      error: SongQueueError,
    }),
  ) {}

/** Shared HTTP contract preserves Option encoding and typed song queue errors across the DO boundary. */
export class SongQueueHttpApi extends HttpApi.make("SongQueueHttpApi")
  .add(SongQueueHttpApiGroup)
  .prefix("/v1") {}
