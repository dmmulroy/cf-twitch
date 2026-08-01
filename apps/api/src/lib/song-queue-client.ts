import { Result } from "better-result";

import { SongQueueCoordinationError, SongQueueParseError } from "../capabilities/song-queue";
import { DurableObjectError, SongQueueDbError } from "./errors";
import { callRpcResultUnsafe } from "./rpc-result";
import {
	DeleteSongRequestResultCodec,
	GetCurrentlyPlayingResultCodec,
	GetDisplayNameRequestCountResultCodec,
	GetRequestHistoryResultCodec,
	GetSongQueueResultCodec,
	GetTopRequestersResultCodec,
	GetTopTracksResultCodec,
	GetUserRequestCountResultCodec,
	GetUserTopTracksResultCodec,
	PersistSongRequestResultCodec,
} from "./song-queue-rpc-result-codecs";

import type { PendingRequestInput } from "../domain/song-request";
import type {
	RequestHistoryResult,
	SpotifyQueueResult as QueueResult,
	TopRequestedTrack as TopTrack,
	TopSongRequester as TopRequester,
} from "../domain/song-request";
import type { NowPlaying } from "../domain/spotify-queue";
import type { SongQueueRpcHandleStub } from "../durable-objects/song-queue-do";

type SongQueueError = SongQueueDbError | SongQueueParseError | SongQueueCoordinationError;

type SongQueueHandleAcquisition = Promise<Result<SongQueueRpcHandleStub, DurableObjectError>>;

/** Typed Song Queue facade that owns Durable Object acquisition, transport, and payload parsing failures. */
export class SongQueueClient {
	private constructor(private readonly handleAcquisition: SongQueueHandleAcquisition) {}

	/** Build a client around one classified Durable Object handle acquisition. */
	static fromHandleAcquisition(handleAcquisition: SongQueueHandleAcquisition): SongQueueClient {
		return new SongQueueClient(handleAcquisition);
	}

	/** Release an acquired RPC handle without allowing disposal failures to escape. */
	[Symbol.dispose](): void {
		void this.handleAcquisition.then((result) => {
			if (result.status === "ok") result.value[Symbol.dispose]?.();
		});
	}

	private async call<T>(
		method: string,
		invoke: (handle: SongQueueRpcHandleStub) => Promise<unknown>,
		deserializeUnsafe: (
			value: unknown,
		) => Result<T, SongQueueError> | Promise<Result<T, SongQueueError>>,
	): Promise<Result<T, SongQueueError | DurableObjectError>> {
		const acquired = await this.handleAcquisition;
		if (acquired.status === "error") return Result.err(acquired.error);
		return callRpcResultUnsafe(method, invoke(acquired.value), deserializeUnsafe);
	}

	/** Persist a parsed Pending Request and its durable synchronization intent. */
	persistRequest(
		request: PendingRequestInput,
	): Promise<Result<void, SongQueueError | DurableObjectError>> {
		return this.call(
			"persistRequest",
			(handle) => handle.persistRequest(request),
			(value) => PersistSongRequestResultCodec.deserializeUnsafe(value),
		);
	}

	/** Delete a Pending Request by event identity. */
	deleteRequest(eventId: string): Promise<Result<void, SongQueueError | DurableObjectError>> {
		return this.call(
			"deleteRequest",
			(handle) => handle.deleteRequest(eventId),
			(value) => DeleteSongRequestResultCodec.deserializeUnsafe(value),
		);
	}

	/** Read a bounded upcoming Spotify Queue snapshot. */
	getSongQueue(limit: number): Promise<Result<QueueResult, SongQueueError | DurableObjectError>> {
		return this.call(
			"getSongQueue",
			(handle) => handle.getSongQueue(limit),
			(value) => GetSongQueueResultCodec.deserializeUnsafe(value),
		);
	}

	/** Read the current Spotify Track with explicit Viewer or autoplay attribution. */
	getCurrentlyPlaying(): Promise<Result<NowPlaying, SongQueueError | DurableObjectError>> {
		return this.call(
			"getCurrentlyPlaying",
			(handle) => handle.getCurrentlyPlaying(),
			(value) => GetCurrentlyPlayingResultCodec.deserializeUnsafe(value),
		);
	}

	/** Read bounded, decoded Request History records. */
	getRequestHistory(
		limit: number,
		offset = 0,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueError | DurableObjectError>> {
		return this.call(
			"getRequestHistory",
			(handle) => handle.getRequestHistory(limit, offset, since, until),
			(value) => GetRequestHistoryResultCodec.deserializeUnsafe(value),
		);
	}

	/** Count fulfilled Song Requests for one stable Viewer ID. */
	getUserRequestCount(
		userId: string,
	): Promise<Result<number, SongQueueError | DurableObjectError>> {
		return this.call(
			"getUserRequestCount",
			(handle) => handle.getUserRequestCount(userId),
			(value) => GetUserRequestCountResultCodec.deserializeUnsafe(value),
		);
	}

	/** Count fulfilled Song Requests for a historical Viewer display name. */
	getUserRequestCountByDisplayName(
		displayName: string,
	): Promise<Result<number, SongQueueError | DurableObjectError>> {
		return this.call(
			"getUserRequestCountByDisplayName",
			(handle) => handle.getUserRequestCountByDisplayName(displayName),
			(value) => GetDisplayNameRequestCountResultCodec.deserializeUnsafe(value),
		);
	}

	/** Aggregate Spotify Tracks by stable Track ID with decoded artist names. */
	getTopTracks(limit: number): Promise<Result<TopTrack[], SongQueueError | DurableObjectError>> {
		return this.call(
			"getTopTracks",
			(handle) => handle.getTopTracks(limit),
			(value) => GetTopTracksResultCodec.deserializeUnsafe(value),
		);
	}

	/** Aggregate one Viewer's Spotify Tracks by stable Track ID. */
	getTopTracksByUser(
		userId: string,
		limit: number,
	): Promise<Result<TopTrack[], SongQueueError | DurableObjectError>> {
		return this.call(
			"getTopTracksByUser",
			(handle) => handle.getTopTracksByUser(userId, limit),
			(value) => GetUserTopTracksResultCodec.deserializeUnsafe(value),
		);
	}

	/** Aggregate Viewers by stable Viewer ID using their most recent display name. */
	getTopRequesters(
		limit: number,
	): Promise<Result<TopRequester[], SongQueueError | DurableObjectError>> {
		return this.call(
			"getTopRequesters",
			(handle) => handle.getTopRequesters(limit),
			(value) => GetTopRequestersResultCodec.deserializeUnsafe(value),
		);
	}
}

/** Create a Song Queue client that classifies namespace, stub, startup, and connectRpc failures. */
export function createSongQueueClient(
	acquireHandle: () => Promise<SongQueueRpcHandleStub>,
): SongQueueClient {
	const acquisition: SongQueueHandleAcquisition = (async () => {
		try {
			return Result.ok(await acquireHandle());
		} catch (cause) {
			return Result.err(
				new DurableObjectError({
					method: "connectRpc",
					message: "Song Queue RPC acquisition failed",
					cause,
				}),
			);
		}
	})();
	return SongQueueClient.fromHandleAcquisition(acquisition);
}
