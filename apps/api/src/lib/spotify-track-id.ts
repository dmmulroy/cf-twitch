import { Result } from "better-result";

import { InvalidSpotifyUrlError } from "./errors";

const spotifyTrackIdEvidence: unique symbol = Symbol("SpotifyTrackId");

/** A Spotify track identifier parsed from a supported track URL or URI. */
export type SpotifyTrackId = string & { readonly [spotifyTrackIdEvidence]: true };

const spotifyTrackUriEvidence: unique symbol = Symbol("SpotifyTrackUri");

/** A canonical Spotify track URI constructed from a parsed track identifier. */
export type SpotifyTrackUri = `spotify:track:${string}` & {
	readonly [spotifyTrackUriEvidence]: true;
};

function parseSpotifyTrackUrl(input: string): string | undefined {
	if (!URL.canParse(input)) return undefined;

	const url = new URL(input);
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.hostname !== "open.spotify.com"
	) {
		return undefined;
	}

	// Search parameters and fragments are intentionally excluded by matching only the pathname.
	return url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)\/?$/)?.[1];
}

/**
 * Parse a Spotify track URL or URI into its track identifier.
 *
 * Query parameters and fragments on track URLs are ignored.
 *
 * @param input - The untrusted Spotify track URL or URI.
 * @returns The parsed track identifier, or an invalid-URL error.
 */
export function parseSpotifyTrackInput(
	input: string,
): Result<SpotifyTrackId, InvalidSpotifyUrlError> {
	const trimmed = input.trim();
	const uriTrackId = trimmed.match(/^spotify:track:([a-zA-Z0-9]+)$/)?.[1];
	const trackId = uriTrackId ?? parseSpotifyTrackUrl(trimmed);

	if (trackId === undefined || trackId.length === 0) {
		return Result.err(new InvalidSpotifyUrlError({ url: input }));
	}

	// SAFETY: The URI and URL parsers only return non-empty alphanumeric track identifiers.
	return Result.ok(trackId as SpotifyTrackId);
}

/**
 * Construct the canonical Spotify URI for a parsed track identifier.
 *
 * @param trackId - A parsed Spotify track identifier.
 * @returns The canonical Spotify track URI.
 */
export function spotifyTrackUri(trackId: SpotifyTrackId): SpotifyTrackUri {
	// SAFETY: SpotifyTrackId can only be obtained from the parser, so interpolation preserves the URI invariant.
	return `spotify:track:${trackId}` as SpotifyTrackUri;
}
