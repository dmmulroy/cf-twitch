import { TaggedError } from "better-result";

import { SongQueueDbError } from "../lib/errors";

import type {
	PendingRequestInput,
	RequestHistoryResult,
	SpotifyQueueResult,
	TopRequestedTrack,
	TopSongRequester,
} from "../domain/song-request";
import type { NowPlaying } from "../domain/spotify-queue";
import type { Result } from "better-result";

/** Expected failure when Song Queue input, RPC data, or persisted state cannot be parsed. */
export class SongQueueParseError extends TaggedError("SongQueueParseError")<{
	readonly boundary: "rpc-input" | "persistence" | "rpc-result";
	readonly operation: string;
	readonly parseError: string;
	readonly message: string;
}> {
	constructor(args: {
		boundary: "rpc-input" | "persistence" | "rpc-result";
		operation: string;
		parseError: string;
	}) {
		super({ ...args, message: `Invalid Song Queue data during ${args.operation}` });
	}
}

/** Expected failure while coordinating durable Song Queue refresh and cleanup work. */
export class SongQueueCoordinationError extends TaggedError("SongQueueCoordinationError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {
	constructor(args: { operation: string; cause?: unknown }) {
		super({ ...args, message: `Song Queue coordination failed during ${args.operation}` });
	}
}

/** Expected failure when a Song Queue Durable Object operation cannot be reached. */
export class SongQueueUnavailableError extends TaggedError("SongQueueUnavailableError")<{
	readonly operation: SongQueueOperation;
	readonly failure: "acquire-stub" | "connect-rpc" | "invoke-rpc";
	readonly message: string;
	readonly cause?: unknown;
}> {
	constructor(args: {
		operation: SongQueueOperation;
		failure: "acquire-stub" | "connect-rpc" | "invoke-rpc";
		cause?: unknown;
	}) {
		super({
			...args,
			message: `Song Queue unavailable during ${args.operation} (${args.failure})`,
		});
	}
}

/** Public Song Queue operations used to classify failures and tracing spans. */
export type SongQueueOperation =
	| "persistPendingRequest"
	| "deletePendingRequest"
	| "getSpotifyQueue"
	| "getNowPlaying"
	| "getRequestHistory"
	| "getViewerRequestCount"
	| "getViewerRequestCountByDisplayName"
	| "getTopTracks"
	| "getViewerTopTracks"
	| "getTopRequesters";

/** Expected Song Queue failures that retain safe operation and failure context. */
export type SongQueueFailure =
	| SongQueueDbError
	| SongQueueParseError
	| SongQueueCoordinationError
	| SongQueueUnavailableError;

/** Reads Now Playing and upcoming Spotify Queue state. */
export interface SongQueueReader {
	/** Reads Now Playing with explicit Viewer or autoplay attribution. */
	getNowPlaying(): Promise<Result<NowPlaying, SongQueueFailure>>;
	/** Reads a bounded upcoming Spotify Queue snapshot. */
	getSpotifyQueue(limit: number): Promise<Result<SpotifyQueueResult, SongQueueFailure>>;
}

/** Persists and removes Pending Requests by their durable event identity. */
export interface PendingRequestStore {
	/** Persists one parsed Pending Request before Spotify Queue mutation. */
	persistPendingRequest(request: PendingRequestInput): Promise<Result<void, SongQueueFailure>>;
	/** Deletes one Pending Request during compensation or cleanup. */
	deletePendingRequest(eventId: string): Promise<Result<void, SongQueueFailure>>;
}

/** Reads Request History and aggregate Song Request statistics. */
export interface SongRequestStatistics {
	/** Reads a bounded page of fulfilled Song Requests. */
	getRequestHistory(
		limit: number,
		offset?: number,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueFailure>>;
	/** Counts fulfilled Song Requests for one stable Viewer ID. */
	getViewerRequestCount(userId: string): Promise<Result<number, SongQueueFailure>>;
	/** Counts fulfilled Song Requests for one historical Viewer display name. */
	getViewerRequestCountByDisplayName(
		displayName: string,
	): Promise<Result<number, SongQueueFailure>>;
	/** Aggregates Spotify Tracks across fulfilled Song Requests. */
	getTopTracks(limit: number): Promise<Result<TopRequestedTrack[], SongQueueFailure>>;
	/** Aggregates one Viewer's requested Spotify Tracks. */
	getViewerTopTracks(
		userId: string,
		limit: number,
	): Promise<Result<TopRequestedTrack[], SongQueueFailure>>;
	/** Aggregates Viewers by fulfilled Song Request count. */
	getTopRequesters(limit: number): Promise<Result<TopSongRequester[], SongQueueFailure>>;
}

/** Complete application-owned Song Queue capability used by composition roots. */
export interface SongQueue extends SongQueueReader, PendingRequestStore, SongRequestStatistics {}
