import { Option, Schema } from "effect";
import {
  IsoTimestamp,
  NonNegativeInt,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "./identity.ts";
import { SpotifyTrack } from "./spotify-track.ts";

/** Bounded song queue page size; limits never exceed one hundred tracks. */
export const SongQueueLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
  Schema.brand("SongQueueLimit"),
);
/** Song queue page size accepted at HTTP and service boundaries. */
export type SongQueueLimit = typeof SongQueueLimit.Type;

/** Pending song request identity is the redemption ID, not a track occurrence ID. */
export const PendingSongRequest = Schema.Struct({
  eventId: RedemptionId,
  track: SpotifyTrack,
  requesterUserId: ViewerId,
  requesterDisplayName: Schema.NonEmptyString,
  requestedAt: IsoTimestamp,
});
/** A request persists before the external Spotify queue mutation. */
export interface PendingSongRequest extends Schema.Schema.Type<typeof PendingSongRequest> {}

/** Spotify queue occurrences distinguish user attribution from autoplay. */
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
/** Attribution belongs to a single occurrence even when track IDs repeat. */
export type QueuedTrack = typeof QueuedTrack.Type;

/** Now playing absence is explicit, and position zero is never an upcoming item. */
export const NowPlaying = Schema.Struct({
  track: Schema.OptionFromNullOr(QueuedTrack),
  position: Schema.Literal(0),
});
/** Current song queue occurrence, or no active playback. */
export interface NowPlaying extends Schema.Schema.Type<typeof NowPlaying> {}

/** Song queue presentation prioritizes requested FIFO ahead of Spotify autoplay order. */
export const SongQueueResult = Schema.Struct({
  tracks: Schema.Array(QueuedTrack).check(Schema.isMaxLength(100)),
  totalCount: NonNegativeInt,
});
/** The total count is measured before applying the page limit. */
export interface SongQueueResult extends Schema.Schema.Type<typeof SongQueueResult> {}

/** Request history records only an attributed current occurrence leaving playback. */
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
/** Fulfilled timestamp means observed playback departure, never redemption fulfillment. */
export interface RequestHistoryItem extends Schema.Schema.Type<typeof RequestHistoryItem> {}

/** Request history pagination uses inclusive instant bounds. */
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
/** History date filtering compares instants, including ISO timestamps with offsets. */
export type RequestHistoryQuery = typeof RequestHistoryQuery.Type;

/** Played request history page, newest playback departure first. */
export const RequestHistoryResult = Schema.Struct({
  requests: Schema.Array(RequestHistoryItem).check(Schema.isMaxLength(100)),
  totalCount: NonNegativeInt,
});
/** Total history matches are measured before pagination. */
export interface RequestHistoryResult extends Schema.Schema.Type<typeof RequestHistoryResult> {}

/** Track statistics aggregate stable Spotify track IDs using latest played metadata. */
export const TopRequestedTrack = Schema.Struct({
  trackId: SpotifyTrackId,
  trackName: Schema.NonEmptyString,
  artists: SpotifyTrack.fields.artists,
  requestCount: NonNegativeInt,
});
/** Played request count for one stable track identity. */
export interface TopRequestedTrack extends Schema.Schema.Type<typeof TopRequestedTrack> {}

/** Viewer statistics aggregate stable viewer IDs using the latest display name. */
export const TopSongRequester = Schema.Struct({
  userId: ViewerId,
  displayName: Schema.NonEmptyString,
  requestCount: NonNegativeInt,
});
/** Played request count for one stable viewer identity. */
export interface TopSongRequester extends Schema.Schema.Type<typeof TopSongRequester> {}

/** Song queue limit options are explicit rather than positional defaults. */
export const SongQueueLimitInput = Schema.Struct({ limit: SongQueueLimit });
/** Song request compensation uses the same durable redemption identity. */
export const SongRequestIdentityInput = Schema.Struct({ eventId: RedemptionId });
/** Viewer song statistics use stable IDs, not display names. */
export const SongQueueViewerInput = Schema.Struct({ userId: ViewerId });
/** Display name lookup preserves the exact public API spelling. */
export const SongQueueDisplayNameInput = Schema.Struct({ displayName: Schema.NonEmptyString });
/** Viewer top tracks combine identity with bounded pagination. */
export const SongQueueViewerTracksInput = Schema.Struct({
  userId: ViewerId,
  limit: SongQueueLimit,
});
/** Session counts include playback departures at the supplied instant. */
export const SongQueueSessionInput = Schema.Struct({ since: IsoTimestamp });
/** Duplicate song requests inspect pending and played requests inside a minute window. */
export const SongQueueDuplicateInput = Schema.Struct({
  userId: ViewerId,
  trackId: SpotifyTrackId,
  windowMinutes: SongQueueLimit,
});

/** Safe song queue failures retain operation and recoverable failure category. */
export class SongQueueError extends Schema.TaggedError<SongQueueError>()("SongQueueError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "storage_unavailable",
    "stored_data_invalid",
    "invalid_response",
    "invalid_input",
    "provider_unavailable",
    "coordination_unavailable",
    "transport_unavailable",
  ]),
}) {
  /** Song queue error messages do not include personal metadata or provider credentials. */
  override get message(): string {
    return `Song queue operation failed: ${this.operation} (${this.reason})`;
  }
}
