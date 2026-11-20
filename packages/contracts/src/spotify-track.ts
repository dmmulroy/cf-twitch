import { Effect, Option, Schema } from "effect";
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

/** Classified reason a Song Request input is not a usable Spotify track reference. */
export const InvalidSpotifyTrackInputReason = Schema.Literals([
  "unsupported_format",
  "invalid_track_id",
]);

/** Classified reason a Song Request input is not a usable Spotify track reference. */
export type InvalidSpotifyTrackInputReason = typeof InvalidSpotifyTrackInputReason.Type;

/** Song Request input that is not a supported Spotify track link or URI. */
export class InvalidSpotifyTrackInput extends Schema.TaggedError<InvalidSpotifyTrackInput>()(
  "InvalidSpotifyTrackInput",
  {
    operation: Schema.Literal("parseSpotifyTrackInput"),
    reason: InvalidSpotifyTrackInputReason,
  },
) {
  /** Correction for the Viewer that never echoes the untrusted request text. */
  override get message(): string {
    switch (this.reason) {
      case "unsupported_format":
        return "Song request is not a Spotify track link or URI. Send an open.spotify.com/track link or a spotify:track URI and try again.";
      case "invalid_track_id":
        return "Song request has an invalid Spotify track ID. Copy the track link from Spotify again and resend it.";
    }
  }
}

const decodeSpotifyTrackId = Schema.decodeEffect(SpotifyTrackId);

/** Returns the track ID segment of a `spotify:track:` URI. */
const spotifyTrackIdFromUri = (input: string): Option.Option<string> =>
  Option.fromUndefinedOr(/^spotify:track:([a-zA-Z0-9]+)$/.exec(input)?.[1]);

/** Returns the track ID segment of an `open.spotify.com` track link, including localized paths. */
const spotifyTrackIdFromUrl = (input: string): Option.Option<string> => {
  if (!URL.canParse(input)) return Option.none();
  const url = new URL(input);

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname !== "open.spotify.com"
  ) {
    return Option.none();
  }

  return Option.fromUndefinedOr(
    /^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname)?.[1],
  );
};

/**
 * Parses a Song Request's Spotify track link or URI into its track ID.
 *
 * **Details**
 *
 * Accepts `spotify:track:` URIs and `open.spotify.com` track links, including localized
 * `intl-xx` paths, and ignores surrounding whitespace, query strings, and fragments.
 *
 * @param input - Raw Song Request text supplied by the Viewer.
 * @returns The Spotify track ID, or fails with `InvalidSpotifyTrackInput` whose reason is
 *   `unsupported_format` when the text is not a track link or URI and `invalid_track_id` when the
 *   extracted ID is not a valid Spotify track ID.
 */
export const parseSpotifyTrackInput = Effect.fn("SpotifyTrack.parseSpotifyTrackInput")(
  function* (input: string) {
    const trimmed = input.trim();

    const trackId = Option.orElse(spotifyTrackIdFromUri(trimmed), () =>
      spotifyTrackIdFromUrl(trimmed),
    );

    if (Option.isNone(trackId)) {
      return yield* new InvalidSpotifyTrackInput({
        operation: "parseSpotifyTrackInput",
        reason: "unsupported_format",
      });
    }

    return yield* decodeSpotifyTrackId(trackId.value);
  },
  Effect.catchTag("SchemaError", () =>
    Effect.fail(
      new InvalidSpotifyTrackInput({
        operation: "parseSpotifyTrackInput",
        reason: "invalid_track_id",
      }),
    ),
  ),
);

/** Returns the canonical `spotify:track:` URI for an already parsed track identity. */
export const spotifyTrackUri = (trackId: SpotifyTrackId): `spotify:track:${string}` =>
  `spotify:track:${trackId}`;
