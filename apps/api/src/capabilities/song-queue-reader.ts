import { TaggedError } from "better-result";

import type { CurrentlyPlayingResult } from "../domain/spotify-queue";
import type { Result } from "better-result";

/** Expected failure when the Song Queue transport cannot be acquired. */
export class SongQueueUnavailableError extends TaggedError("SongQueueUnavailableError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "Song Queue is temporarily unavailable" });
	}
}

/** Expected failure when a Now Playing read cannot be completed. */
export class SongQueueReadError extends TaggedError("SongQueueReadError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "Song Queue Now Playing read failed" });
	}
}

/** Application-owned failures exposed by a Song Queue read capability. */
export type SongQueueReadFailure = SongQueueUnavailableError | SongQueueReadError;

/** Reads the current Spotify Track without exposing Durable Object transport mechanics. */
export interface SongQueueReader {
	/** Reads Now Playing with explicit Viewer or autoplay attribution. */
	getNowPlaying(): Promise<Result<CurrentlyPlayingResult, SongQueueReadFailure>>;
}
