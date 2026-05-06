import { describe, expect, it } from "vitest";

import { parseSpotifyTrackInput, spotifyTrackUri } from "../../lib/spotify-track-id";

describe("parseSpotifyTrackInput", () => {
	it("accepts a Spotify track URI and creates a queue URI from parsed evidence", () => {
		const result = parseSpotifyTrackInput("spotify:track:4iV5W9uYEdYUVa79Axb7Rh");

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBe("4iV5W9uYEdYUVa79Axb7Rh");
			expect(spotifyTrackUri(result.value)).toBe("spotify:track:4iV5W9uYEdYUVa79Axb7Rh");
		}
	});

	it("accepts open.spotify.com track URLs", () => {
		const result = parseSpotifyTrackInput("https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh");

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBe("4iV5W9uYEdYUVa79Axb7Rh");
		}
	});

	it("accepts localized track URLs with query parameters", () => {
		const result = parseSpotifyTrackInput(
			"https://open.spotify.com/intl-de/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc123",
		);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toBe("4iV5W9uYEdYUVa79Axb7Rh");
		}
	});

	it("rejects non-track URLs and empty input", () => {
		const invalidInputs = [
			"https://open.spotify.com/album/4iV5W9uYEdYUVa79Axb7Rh",
			"https://example.com/track/4iV5W9uYEdYUVa79Axb7Rh",
			"",
		];

		for (const input of invalidInputs) {
			const result = parseSpotifyTrackInput(input);
			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("InvalidSpotifyUrlError");
			}
		}
	});
});
