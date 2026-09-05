import { Result } from "better-result";

import {
	SongQueueUnavailableError,
	type SongQueue,
	type SongQueueFailure,
	type SongQueueOperation,
} from "../../capabilities/song-queue";
import {
	type PendingRequestInput,
	type RequestHistoryResult,
	type SpotifyQueueResult,
	type TopRequestedTrack,
	type TopSongRequester,
} from "../../domain/song-request";
import { SONG_QUEUE_DO_NAME } from "../../durable-objects/song-queue-do";
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
} from "../../lib/song-queue-rpc-result-codecs";

import type { Tracer } from "../../capabilities/tracer";
import type { NowPlaying } from "../../domain/spotify-queue";
import type { RpcWireValue } from "../../lib/rpc-result";

type SongQueueSpanNameMap = {
	readonly [Operation in SongQueueOperation]: string;
};

const SongQueueSpanNames: SongQueueSpanNameMap = {
	persistPendingRequest: "durable_object.song_queue.persist_pending_request",
	deletePendingRequest: "durable_object.song_queue.delete_pending_request",
	getSpotifyQueue: "durable_object.song_queue.get_spotify_queue",
	getNowPlaying: "durable_object.song_queue.get_now_playing",
	getRequestHistory: "durable_object.song_queue.get_request_history",
	getViewerRequestCount: "durable_object.song_queue.get_viewer_request_count",
	getViewerRequestCountByDisplayName:
		"durable_object.song_queue.get_viewer_request_count_by_display_name",
	getTopTracks: "durable_object.song_queue.get_top_tracks",
	getViewerTopTracks: "durable_object.song_queue.get_viewer_top_tracks",
	getTopRequesters: "durable_object.song_queue.get_top_requesters",
};

export interface SongQueueRpcHandle {
	persistRequest(request: PendingRequestInput): Promise<RpcWireValue>;
	deleteRequest(eventId: string): Promise<RpcWireValue>;
	getSongQueue(limit: number): Promise<RpcWireValue>;
	getCurrentlyPlaying(): Promise<RpcWireValue>;
	getRequestHistory(
		limit: number,
		offset: number,
		since?: string,
		until?: string,
	): Promise<RpcWireValue>;
	getUserRequestCount(userId: string): Promise<RpcWireValue>;
	getUserRequestCountByDisplayName(displayName: string): Promise<RpcWireValue>;
	getTopTracks(limit: number): Promise<RpcWireValue>;
	getTopTracksByUser(userId: string, limit: number): Promise<RpcWireValue>;
	getTopRequesters(limit: number): Promise<RpcWireValue>;
	[Symbol.dispose]?(): void;
}

/** Minimal namespace contract required to acquire one Song Queue RPC connection. */
export interface SongQueueRpcNamespace<NamespaceId> {
	idFromName(name: string): NamespaceId;
	get(id: NamespaceId): Readonly<{ connectRpc(): Promise<SongQueueRpcHandle> }>;
}

/** Durable Object adapter that owns Song Queue acquisition, RPC transport, parsing, and translation. */
export class DurableObjectSongQueue<NamespaceId = DurableObjectId> implements SongQueue {
	constructor(
		private readonly namespace: SongQueueRpcNamespace<NamespaceId>,
		private readonly tracer: Tracer,
	) {}

	/** Persists a Pending Request through the runtime-validated Song Queue RPC contract. */
	persistPendingRequest(request: PendingRequestInput): Promise<Result<void, SongQueueFailure>> {
		return this.call(
			"persistPendingRequest",
			"persistRequest",
			(handle) => handle.persistRequest(request),
			(value) => PersistSongRequestResultCodec.deserializeUnsafe(value),
		);
	}

	/** Deletes a Pending Request through the runtime-validated Song Queue RPC contract. */
	deletePendingRequest(eventId: string): Promise<Result<void, SongQueueFailure>> {
		return this.call(
			"deletePendingRequest",
			"deleteRequest",
			(handle) => handle.deleteRequest(eventId),
			(value) => DeleteSongRequestResultCodec.deserializeUnsafe(value),
		);
	}

	/** Reads and runtime-validates the complete Now Playing RPC result. */
	getNowPlaying(): Promise<Result<NowPlaying, SongQueueFailure>> {
		return this.call(
			"getNowPlaying",
			"getCurrentlyPlaying",
			(handle) => handle.getCurrentlyPlaying(),
			(value) => GetCurrentlyPlayingResultCodec.deserializeUnsafe(value),
		);
	}

	/** Reads and runtime-validates a bounded upcoming Spotify Queue snapshot. */
	getSpotifyQueue(limit: number): Promise<Result<SpotifyQueueResult, SongQueueFailure>> {
		return this.call(
			"getSpotifyQueue",
			"getSongQueue",
			(handle) => handle.getSongQueue(limit),
			(value) => GetSongQueueResultCodec.deserializeUnsafe(value),
		);
	}

	/** Reads and runtime-validates a bounded Request History page. */
	getRequestHistory(
		limit: number,
		offset = 0,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueFailure>> {
		return this.call(
			"getRequestHistory",
			"getRequestHistory",
			(handle) => handle.getRequestHistory(limit, offset, since, until),
			(value) => GetRequestHistoryResultCodec.deserializeUnsafe(value),
		);
	}

	/** Counts fulfilled Song Requests for one stable Viewer ID. */
	getViewerRequestCount(userId: string): Promise<Result<number, SongQueueFailure>> {
		return this.call(
			"getViewerRequestCount",
			"getUserRequestCount",
			(handle) => handle.getUserRequestCount(userId),
			(value) => GetUserRequestCountResultCodec.deserializeUnsafe(value),
		);
	}

	/** Counts fulfilled Song Requests for one historical Viewer display name. */
	getViewerRequestCountByDisplayName(
		displayName: string,
	): Promise<Result<number, SongQueueFailure>> {
		return this.call(
			"getViewerRequestCountByDisplayName",
			"getUserRequestCountByDisplayName",
			(handle) => handle.getUserRequestCountByDisplayName(displayName),
			(value) => GetDisplayNameRequestCountResultCodec.deserializeUnsafe(value),
		);
	}

	/** Aggregates Spotify Tracks across fulfilled Song Requests. */
	getTopTracks(limit: number): Promise<Result<TopRequestedTrack[], SongQueueFailure>> {
		return this.call(
			"getTopTracks",
			"getTopTracks",
			(handle) => handle.getTopTracks(limit),
			(value) => GetTopTracksResultCodec.deserializeUnsafe(value),
		);
	}

	/** Aggregates one Viewer's requested Spotify Tracks. */
	getViewerTopTracks(
		userId: string,
		limit: number,
	): Promise<Result<TopRequestedTrack[], SongQueueFailure>> {
		return this.call(
			"getViewerTopTracks",
			"getTopTracksByUser",
			(handle) => handle.getTopTracksByUser(userId, limit),
			(value) => GetUserTopTracksResultCodec.deserializeUnsafe(value),
		);
	}

	/** Aggregates Viewers by fulfilled Song Request count. */
	getTopRequesters(limit: number): Promise<Result<TopSongRequester[], SongQueueFailure>> {
		return this.call(
			"getTopRequesters",
			"getTopRequesters",
			(handle) => handle.getTopRequesters(limit),
			(value) => GetTopRequestersResultCodec.deserializeUnsafe(value),
		);
	}

	private call<T, WireValue>(
		operation: SongQueueOperation,
		rpcMethod: string,
		invoke: (handle: SongQueueRpcHandle) => Promise<WireValue>,
		deserializeUnsafe: (
			value: WireValue,
		) => Result<T, SongQueueFailure> | Promise<Result<T, SongQueueFailure>>,
	): Promise<Result<T, SongQueueFailure>> {
		return this.tracer.span(
			SongQueueSpanNames[operation],
			{ operation, rpc_method: rpcMethod },
			async () => {
				let stub: ReturnType<SongQueueRpcNamespace<NamespaceId>["get"]>;
				try {
					stub = this.namespace.get(this.namespace.idFromName(SONG_QUEUE_DO_NAME));
				} catch (cause) {
					return Result.err(
						new SongQueueUnavailableError({ operation, failure: "acquire-stub", cause }),
					);
				}

				let handle: SongQueueRpcHandle;
				try {
					handle = await stub.connectRpc();
				} catch (cause) {
					return Result.err(
						new SongQueueUnavailableError({ operation, failure: "connect-rpc", cause }),
					);
				}

				let rawResult: WireValue;
				try {
					rawResult = await invoke(handle);
				} catch (cause) {
					return Result.err(
						new SongQueueUnavailableError({ operation, failure: "invoke-rpc", cause }),
					);
				} finally {
					handle[Symbol.dispose]?.();
				}

				return await deserializeUnsafe(rawResult);
			},
		);
	}
}
