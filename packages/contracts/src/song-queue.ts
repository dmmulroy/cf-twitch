import { Effect, Option, Schema } from "effect";
import {
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "./identity.ts";
import { SpotifyTrack } from "./spotify-track.ts";

/** Schema for a song queue page size between 1 and 100 tracks. */
export const SongQueueLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
  Schema.brand("SongQueueLimit"),
);

/** Song queue page size between 1 and 100 tracks. */
export type SongQueueLimit = typeof SongQueueLimit.Type;

/** Schema for an accepted Song Request, identified by its redemption ID rather than a Queue Occurrence. */
export const PendingSongRequest = Schema.Struct({
  eventId: RedemptionId,
  track: SpotifyTrack,
  requesterUserId: ViewerId,
  requesterDisplayName: Schema.NonEmptyString,
  requestedAt: IsoTimestamp,
});

/** Accepted Song Request, persisted before its Spotify queue mutation. */
export interface PendingSongRequest extends Schema.Schema.Type<typeof PendingSongRequest> {}

/** Schema for a Queue Occurrence's track, attributed to a Viewer (`user`) or unattributed (`autoplay`). */
export const QueuedTrack = Schema.Union([
  Schema.Struct({ ...SpotifyTrack.fields, source: Schema.Literal("autoplay") }),
  Schema.Struct({
    ...SpotifyTrack.fields,
    source: Schema.Literal("user"),
    eventId: RedemptionId,
    requesterUserId: ViewerId,
    requesterDisplayName: Schema.NonEmptyString,
    requestedAt: IsoTimestamp,
  }),
]);

/** Queue Occurrence track whose attribution belongs to this occurrence even when track IDs repeat. */
export type QueuedTrack = typeof QueuedTrack.Type;

/** Schema for Now Playing: the current occurrence or none, always at position zero. */
export const NowPlaying = Schema.Struct({
  track: Schema.OptionFromNullOr(QueuedTrack),
  position: Schema.Literal(0),
});

/** Now Playing occurrence, or none when no playback is active. */
export interface NowPlaying extends Schema.Schema.Type<typeof NowPlaying> {}

/** Schema for a song queue page: requested tracks in FIFO order ahead of Spotify autoplay order. */
export const SongQueueResult = Schema.Struct({
  tracks: Schema.Array(QueuedTrack).check(Schema.isMaxLength(100)),
  totalCount: NonNegativeInt,
});

/** Song queue page whose total count is measured before the page limit applies. */
export interface SongQueueResult extends Schema.Schema.Type<typeof SongQueueResult> {}

/** Schema for one Request History item: an attributed current occurrence that left playback. */
export const RequestHistoryItem = Schema.Struct({
  eventId: RedemptionId,
  trackId: SpotifyTrackId,
  trackName: Schema.NonEmptyString,
  artists: SpotifyTrack.fields.artists,
  album: SpotifyTrack.fields.album,
  albumCoverUrl: SpotifyTrack.fields.albumCoverUrl,
  requesterUserId: ViewerId,
  requesterDisplayName: Schema.NonEmptyString,
  requestedAt: IsoTimestamp,
  fulfilledAt: IsoTimestamp,
});

/** Request History item whose `fulfilledAt` is the observed playback departure, not Redemption Fulfillment. */
export interface RequestHistoryItem extends Schema.Schema.Type<typeof RequestHistoryItem> {}

/** Schema for a Request History page query with inclusive `since`/`until` instant bounds. */
export const RequestHistoryQuery = Schema.Struct({
  limit: SongQueueLimit,
  offset: NonNegativeInt.check(Schema.isLessThanOrEqualTo(10_000)),
  since: Schema.OptionFromNullOr(IsoTimestamp),
  until: Schema.OptionFromNullOr(IsoTimestamp),
})
  .check(
    Schema.makeFilter(
      (query) =>
        Option.isNone(query.since) ||
        Option.isNone(query.until) ||
        Date.parse(query.since.value) <= Date.parse(query.until.value),
      { message: "Song queue history since must not follow until" },
    ),
  )
  .pipe(Schema.brand("RequestHistoryQuery"));

/** Request History query whose date bounds compare instants, including timestamps with offsets. */
export type RequestHistoryQuery = typeof RequestHistoryQuery.Type;

/** Schema for a Request History page, newest playback departure first. */
export const RequestHistoryResult = Schema.Struct({
  requests: Schema.Array(RequestHistoryItem).check(Schema.isMaxLength(100)),
  totalCount: NonNegativeInt,
});

/** Request History page whose total count is measured before pagination. */
export interface RequestHistoryResult extends Schema.Schema.Type<typeof RequestHistoryResult> {}

/** Schema for a top requested Spotify Track, aggregated by track ID with its latest played metadata. */
export const TopRequestedTrack = Schema.Struct({
  trackId: SpotifyTrackId,
  trackName: Schema.NonEmptyString,
  artists: SpotifyTrack.fields.artists,
  requestCount: NonNegativeInt,
});

/** Played Song Request count for one Spotify Track ID. */
export interface TopRequestedTrack extends Schema.Schema.Type<typeof TopRequestedTrack> {}

/** Schema for a top song requester, aggregated by Viewer ID with the latest display name. */
export const TopSongRequester = Schema.Struct({
  userId: ViewerId,
  displayName: Schema.NonEmptyString,
  requestCount: NonNegativeInt,
});

/** Played Song Request count for one Viewer ID. */
export interface TopSongRequester extends Schema.Schema.Type<typeof TopSongRequester> {}

/** Schema for a song queue query that takes only a page size. */
export const SongQueueLimitInput = Schema.Struct({ limit: SongQueueLimit });

/** Schema for the redemption ID that identifies a Song Request to compensate. */
export const SongRequestIdentityInput = Schema.Struct({ eventId: RedemptionId });

/** Schema for a Viewer statistics query by stable Viewer ID, not display name. */
export const SongQueueViewerInput = Schema.Struct({ userId: ViewerId });

/** Schema for a statistics query by exact display name, as spelled in the public API. */
export const SongQueueDisplayNameInput = Schema.Struct({ displayName: Schema.NonEmptyString });

/** Schema for one Viewer's top tracks query with a page size. */
export const SongQueueViewerTracksInput = Schema.Struct({
  userId: ViewerId,
  limit: SongQueueLimit,
});

/** Schema for a Stream Session count query; departures at exactly `since` are included. */
export const SongQueueSessionInput = Schema.Struct({ since: IsoTimestamp });

/** Schema for a duplicate Song Request check over pending and played requests within `windowMinutes`. */
export const SongQueueDuplicateInput = Schema.Struct({
  userId: ViewerId,
  trackId: SpotifyTrackId,
  windowMinutes: SongQueueLimit,
});

/** Song queue operation names recorded on typed song queue failures. */
export const SongQueueOperation = Schema.Literals([
  "persistRequest",
  "deleteRequest",
  "getSongQueue",
  "getCurrentlyPlaying",
  "getRequestHistory",
  "getUserRequestCount",
  "getUserRequestCountByDisplayName",
  "getSessionRequestCount",
  "getTopTracks",
  "getTopTracksByUser",
  "getTopRequesters",
  "checkDuplicateRequest",
  "refreshQueue",
  "reconcilePlayback",
  "cleanupPending",
  "getCoordination",
  "setCoordination",
  "scheduleAlarm",
]);

/** Song queue operation name recorded on typed song queue failures. */
export type SongQueueOperation = typeof SongQueueOperation.Type;

/** Classified cause of a song queue failure. */
export const SongQueueFailureReason = Schema.Literals([
  "storage_unavailable",
  "stored_data_invalid",
  "invalid_response",
  "invalid_input",
  "provider_unavailable",
  "coordination_unavailable",
  "transport_unavailable",
]);

/** Classified cause of a song queue failure. */
export type SongQueueFailureReason = typeof SongQueueFailureReason.Type;

/**
 * Expected song queue failure carrying the operation, classified reason, and Song Request identity.
 *
 * **Details**
 *
 * Every song queue mutation is idempotent by redemption ID (receipts and compensation tombstones),
 * so messages may direct callers to retry the same request after transient failures.
 */
export class SongQueueError extends Schema.TaggedError<SongQueueError>()("SongQueueError", {
  operation: SongQueueOperation,
  reason: SongQueueFailureReason,
  eventId: Schema.OptionFromNullOr(RedemptionId).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<RedemptionId>())),
  ),
}) {
  /** Message naming the failed operation and reason, without viewer metadata or credentials. */
  override get message(): string {
    switch (this.reason) {
      case "storage_unavailable":
        return `Song queue storage was unavailable during ${this.operation}. Retry the same request; song queue writes are idempotent by redemption ID.`;
      case "stored_data_invalid":
        return `Song queue stored data failed validation during ${this.operation}. Inspect the stored song queue data before retrying.`;
      case "invalid_response":
        return `Song queue response failed validation during ${this.operation}. Read the song queue to confirm the outcome before retrying.`;
      case "invalid_input":
        return `Song queue input was rejected during ${this.operation}. Correct the request fields and send it again.`;
      case "provider_unavailable":
        return `Song queue could not read Spotify playback during ${this.operation}. Retry after Spotify is reachable; the last saved queue snapshot is kept.`;
      case "coordination_unavailable":
        return `Song queue polling alarm could not be scheduled during ${this.operation}. Retry the same request to schedule polling again.`;
      case "transport_unavailable":
        return `Song queue service was unreachable during ${this.operation}. Retry the same request; song queue writes are idempotent by redemption ID.`;
    }
  }
}
