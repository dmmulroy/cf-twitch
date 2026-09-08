import { Effect, Schema } from "effect";
import { NonNegativeInt, SpotifyTrackId } from "./identity.ts";

const spotifyArtworkUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => URL.canParse(value) && /^https?:\/\//.test(value), {
    message: "Spotify artwork URL must use HTTP or HTTPS",
  }),
);

/** Spotify track metadata; absent artwork is an Option rather than a nullable domain field. */
export const SpotifyTrack = Schema.Struct({
  id: SpotifyTrackId,
  name: Schema.NonEmptyString,
  artists: Schema.Array(Schema.NonEmptyString),
  album: Schema.NonEmptyString,
  albumCoverUrl: Schema.OptionFromNullOr(spotifyArtworkUrl),
});
/** Parsed Spotify track metadata shared by provider and song queue capabilities. */
export type SpotifyTrack = typeof SpotifyTrack.Type;

/** Provider playback snapshot; the queue excludes the currently playing occurrence. */
export const SpotifyPlayback = Schema.Struct({
  currentlyPlaying: Schema.OptionFromNullOr(SpotifyTrack),
  queue: Schema.Array(SpotifyTrack),
  isPlaying: Schema.Boolean,
  progressMs: NonNegativeInt,
});
/** Parsed playback evidence from Spotify, including paused playback. */
export type SpotifyPlayback = typeof SpotifyPlayback.Type;

/** Song request input is not a supported Spotify track link or URI. */
export class InvalidSpotifyTrackInput extends Schema.TaggedError<InvalidSpotifyTrackInput>()(
  "InvalidSpotifyTrackInput",
  {},
) {
  /** A safe correction that does not echo untrusted request text. */
  override get message(): string {
    return "Spotify track input is invalid. Supply a Spotify track link or spotify:track URI.";
  }
}

const parseSpotifyTrackIdentity = Schema.decodeEffect(SpotifyTrackId);

const spotifyTrackIdFromUri = (input: string): string | undefined =>
  input.match(/^spotify:track:([a-zA-Z0-9]+)$/)?.[1];

const spotifyTrackIdFromUrl = (input: string): string | undefined => {
  if (!URL.canParse(input)) return undefined;
  const url = new URL(input);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname !== "open.spotify.com"
  ) {
    return undefined;
  }
  return url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)\/?$/)?.[1];
};

/** Parse track links, localized links and URIs, ignoring URL query strings and fragments. */
export const parseSpotifyTrackInput = Effect.fn("SpotifyTrack.parseSpotifyTrackInput")(
  function* (input: string) {
    const trimmed = input.trim();
    const trackId = spotifyTrackIdFromUri(trimmed) ?? spotifyTrackIdFromUrl(trimmed);
    if (trackId === undefined) return yield* new InvalidSpotifyTrackInput();
    return yield* parseSpotifyTrackIdentity(trackId);
  },
  Effect.catchTag("SchemaError", () => Effect.fail(new InvalidSpotifyTrackInput())),
);

/** Construct the canonical Spotify track URI from an already parsed track identity. */
export const spotifyTrackUri = (trackId: SpotifyTrackId): `spotify:track:${string}` =>
  `spotify:track:${trackId}`;
