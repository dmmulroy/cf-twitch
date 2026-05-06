import { Result } from "better-result";

import { InvalidSpotifyUrlError } from "./errors";

const spotifyTrackIdEvidence: unique symbol = Symbol("SpotifyTrackId");

export type SpotifyTrackId = string & { readonly [spotifyTrackIdEvidence]: true };

const spotifyTrackUriEvidence: unique symbol = Symbol("SpotifyTrackUri");

export type SpotifyTrackUri = `spotify:track:${string}` & {
	readonly [spotifyTrackUriEvidence]: true;
};

export function parseSpotifyTrackInput(
	input: string,
): Result<SpotifyTrackId, InvalidSpotifyUrlError> {
	const trimmed = input.trim();
	const uriMatch = trimmed.match(/^spotify:track:([a-zA-Z0-9]+)$/);
	const urlMatch = trimmed.match(
		/^https?:\/\/open\.spotify\.com(?:\/intl-[a-z]{2})?\/track\/([a-zA-Z0-9]+)/,
	);
	const trackId = uriMatch?.[1] ?? urlMatch?.[1];

	if (trackId === undefined || trackId.length === 0) {
		return Result.err(new InvalidSpotifyUrlError({ url: input }));
	}

	return Result.ok(trackId as SpotifyTrackId);
}

export function spotifyTrackUri(trackId: SpotifyTrackId): SpotifyTrackUri {
	return `spotify:track:${trackId}` as SpotifyTrackUri;
}
