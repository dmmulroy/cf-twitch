import { Context, type Effect } from "effect";
import type {
  PendingSongRequest,
  NowPlaying,
  SongQueueResult,
  RequestHistoryQuery,
  RequestHistoryResult,
  TopRequestedTrack,
  TopSongRequester,
  SongQueueError,
  SongQueueLimitInput,
  SongRequestIdentityInput,
  SongQueueViewerInput,
  SongQueueDisplayNameInput,
  SongQueueViewerTracksInput,
  SongQueueSessionInput,
  SongQueueDuplicateInput,
} from "@cf-twitch/contracts/song-queue";

/** Song queue authority owns occurrence attribution, played history, and durable refresh. */
export interface ISongQueue {
  readonly persistRequest: (input: PendingSongRequest) => Effect.Effect<void, SongQueueError>;
  readonly deleteRequest: (
    input: typeof SongRequestIdentityInput.Type,
  ) => Effect.Effect<void, SongQueueError>;
  readonly getSongQueue: (
    input: typeof SongQueueLimitInput.Type,
  ) => Effect.Effect<SongQueueResult, SongQueueError>;
  readonly getCurrentlyPlaying: () => Effect.Effect<NowPlaying, SongQueueError>;
  readonly getRequestHistory: (
    input: RequestHistoryQuery,
  ) => Effect.Effect<RequestHistoryResult, SongQueueError>;
  readonly getUserRequestCount: (
    input: typeof SongQueueViewerInput.Type,
  ) => Effect.Effect<number, SongQueueError>;
  readonly getUserRequestCountByDisplayName: (
    input: typeof SongQueueDisplayNameInput.Type,
  ) => Effect.Effect<number, SongQueueError>;
  readonly getSessionRequestCount: (
    input: typeof SongQueueSessionInput.Type,
  ) => Effect.Effect<number, SongQueueError>;
  readonly getTopTracks: (
    input: typeof SongQueueLimitInput.Type,
  ) => Effect.Effect<readonly TopRequestedTrack[], SongQueueError>;
  readonly getTopTracksByUser: (
    input: typeof SongQueueViewerTracksInput.Type,
  ) => Effect.Effect<readonly TopRequestedTrack[], SongQueueError>;
  readonly getTopRequesters: (
    input: typeof SongQueueLimitInput.Type,
  ) => Effect.Effect<readonly TopSongRequester[], SongQueueError>;
  readonly checkDuplicateRequest: (
    input: typeof SongQueueDuplicateInput.Type,
  ) => Effect.Effect<boolean, SongQueueError>;
  /** Force Spotify reconciliation; never retries a Spotify mutation. */
  readonly refreshQueue: () => Effect.Effect<void, SongQueueError>;
}

/** Application song queue capability shared by the local server and HTTP client. */
export class SongQueue extends Context.Service<SongQueue, ISongQueue>()("@cf-twitch/SongQueue") {}
