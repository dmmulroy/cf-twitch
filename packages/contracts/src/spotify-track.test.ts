import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SpotifyTrackId } from "./identity.ts";
import { parseSpotifyTrackInput, spotifyTrackUri } from "./spotify-track.ts";

describe("Spotify track input", () => {
  it.prop(
    "preserves track identity across supported URI and localized URL forms",
    [SpotifyTrackId],
    ([trackId]) => {
      const inputs = [
        spotifyTrackUri(trackId),
        `https://open.spotify.com/track/${trackId}`,
        `https://open.spotify.com/intl-de/track/${trackId}/?si=ignored#ignored`,
        `  http://open.spotify.com/track/${trackId}  `,
      ];

      for (const input of inputs) {
        expect(Effect.runSync(parseSpotifyTrackInput(input))).toBe(trackId);
      }
    },
    { arbitrary: { runs: 100 } },
  );

  it.effect("rejects non-track resources and lookalike hosts without echoing request text", () =>
    Effect.gen(function* () {
      for (const input of [
        "https://open.spotify.com.attacker.example/track/abc",
        "https://attacker.example/track/abc",
        "https://open.spotify.com/playlist/abc",
        "https://open.spotify.com/track/abc/extra",
        "https://open.spotify.com/track/abc%2Fdef",
        "spotify:album:abc",
        "spotify:track:abc?secret=private",
        "file://open.spotify.com/track/abc",
      ]) {
        const error = yield* Effect.flip(parseSpotifyTrackInput(input));
        expect(error._tag).toBe("InvalidSpotifyTrackInput");
        expect(error.message).not.toContain(input);
      }
    }),
  );
});
